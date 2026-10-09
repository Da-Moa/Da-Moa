import { Injectable } from '@nestjs/common';
import * as oidc from 'openid-client';
import {
  compactVerify,
  createRemoteJWKSet,
  customFetch,
  errors,
  type FlattenedJWSInput,
  type JWSHeaderParameters,
} from 'jose';
import {
  currentTimestamp,
  type KakaoConfig,
  type KakaoProfile,
} from '../authUtil';

const CLOCK_SKEW_SECONDS = 60;
const REQUEST_TIMEOUT_MS = 10_000;
const JWKS_CACHE_MS = 300_000;
// Pinned Kakao metadata avoids a discovery request during login or startup.
const KAKAO_METADATA: oidc.ServerMetadata = {
  issuer: 'https://kauth.kakao.com',
  authorization_endpoint: 'https://kauth.kakao.com/oauth/authorize',
  token_endpoint: 'https://kauth.kakao.com/oauth/token',
  userinfo_endpoint: 'https://kapi.kakao.com/v1/oidc/userinfo',
  jwks_uri: 'https://kauth.kakao.com/.well-known/jwks.json',
  id_token_signing_alg_values_supported: ['RS256'],
};

// The SDK supplies its deadline signal; do not follow redirects or use Next's cache.
const providerFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, cache: 'no-store', redirect: 'error' });

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() || null : null;
}
function httpsUrl(value: unknown): string | null {
  const candidate = text(value);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function invalidIdTokenOrState(error: unknown) {
  if (!(error instanceof oidc.ClientError)) return false;
  if (
    error.code === 'OAUTH_JWT_CLAIM_COMPARISON_FAILED' ||
    error.code === 'OAUTH_JWT_TIMESTAMP_CHECK_FAILED'
  )
    return true;
  // These generic SDK codes also cover malformed token-endpoint responses.
  // Preserve the callback's invalid/failed distinction using the SDK cause.
  return (
    [
      'OAUTH_INVALID_RESPONSE',
      'OAUTH_PARSE_ERROR',
      'OAUTH_UNSUPPORTED_OPERATION',
    ].includes(error.code ?? '') &&
    error.cause instanceof Error &&
    /JWT|ID Token|"state"/.test(error.cause.message)
  );
}

class KakaoJwksRequestError extends Error {}

@Injectable()
export class KakaoOidcClient {
  private readonly keys = createRemoteJWKSet(
    new URL(KAKAO_METADATA.jwks_uri!),
    {
      cacheMaxAge: JWKS_CACHE_MS,
      cooldownDuration: JWKS_CACHE_MS,
      timeoutDuration: REQUEST_TIMEOUT_MS,
      [customFetch]: async (input, init) => {
        try {
          return await providerFetch(input, init);
        } catch (cause) {
          throw new KakaoJwksRequestError('Kakao JWKS request failed', {
            cause,
          });
        }
      },
    },
  );

  private configuration(config: KakaoConfig) {
    const client = new oidc.Configuration(
      KAKAO_METADATA,
      config.clientId,
      {
        id_token_signed_response_alg: 'RS256',
        [oidc.clockTolerance]: CLOCK_SKEW_SECONDS,
      },
      config.clientSecret
        ? oidc.ClientSecretPost(config.clientSecret)
        : oidc.None(),
    );
    client.timeout = REQUEST_TIMEOUT_MS / 1000;
    client[oidc.customFetch] = (url, options) =>
      providerFetch(url, {
        ...options,
        body:
          options.body instanceof Uint8Array
            ? new Uint8Array(options.body)
            : options.body,
      });
    return client;
  }

  async authorize(config: KakaoConfig) {
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const url = oidc.buildAuthorizationUrl(this.configuration(config), {
      code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
      nonce,
      redirect_uri: config.redirectUri,
      scope: 'openid,profile_nickname,profile_image,account_email',
      state,
    });
    return { codeVerifier, nonce, state, url: url.toString() };
  }

  private readonly signingKey = async (
    header: JWSHeaderParameters,
    token: FlattenedJWSInput,
  ) => {
    if (typeof header.kid !== 'string') throw new errors.JWKSNoMatchingKey();
    let key;
    try {
      key = await this.keys(header, token);
    } catch (error) {
      if (
        !(error instanceof errors.JWKSNoMatchingKey) ||
        this.keys.jwks()?.keys.some((candidate) => candidate.kid === header.kid)
      )
        throw error;
      // A new kid bypasses the SDK cooldown once. Retry only JWKS resolution,
      // never the single-use authorization-code exchange.
      await this.keys.reload();
      key = await this.keys(header, token);
    }
    const metadata = this.keys
      .jwks()
      ?.keys.find((candidate) => candidate.kid === header.kid);
    if (
      !metadata ||
      metadata.kty !== 'RSA' ||
      metadata.alg !== 'RS256' ||
      metadata.use !== 'sig' ||
      typeof metadata.n !== 'string' ||
      typeof metadata.e !== 'string'
    )
      throw new errors.JWKSNoMatchingKey();
    return key;
  };

  async authenticate(
    config: KakaoConfig,
    code: string,
    state: string,
    expected: { state: string; nonce: string; codeVerifier: string },
  ): Promise<{ accessToken: string; subject: string } | null> {
    const callback = new URL(config.redirectUri);
    callback.search = new URLSearchParams({ code, state }).toString();
    let result: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers;
    try {
      result = await oidc.authorizationCodeGrant(
        this.configuration(config),
        callback,
        {
          expectedState: expected.state,
          expectedNonce: expected.nonce,
          pkceCodeVerifier: expected.codeVerifier,
          idTokenExpected: true,
        },
      );
    } catch (error) {
      if (invalidIdTokenOrState(error)) return null;
      throw error;
    }
    try {
      // openid-client validates OIDC claims. jose owns RS256/JWKS verification
      // separately so key rotation cannot replay an authorization code.
      await compactVerify(result.id_token!, this.signingKey, {
        algorithms: ['RS256'],
      });
    } catch (error) {
      if (error instanceof KakaoJwksRequestError) throw error;
      if (
        error instanceof errors.JOSEError ||
        error instanceof TypeError ||
        error instanceof DOMException
      )
        return null;
      throw error;
    }
    const claims = result.claims()!;
    if (
      !Number.isSafeInteger(claims.exp) ||
      !Number.isSafeInteger(claims.iat) ||
      claims.iat > currentTimestamp() + CLOCK_SKEW_SECONDS ||
      (Array.isArray(claims.aud) &&
        !claims.aud.every((audience) => typeof audience === 'string')) ||
      typeof claims.sub !== 'string' ||
      !claims.sub
    )
      return null;
    return { accessToken: result.access_token, subject: claims.sub };
  }

  async profile(
    config: KakaoConfig,
    accessToken: string,
    subject: string,
  ): Promise<KakaoProfile> {
    const info = await oidc.fetchUserInfo(
      this.configuration(config),
      accessToken,
      subject,
    );
    // This Kakao-specific endpoint supplies verified email flags and full profile
    // images that are not necessarily present in standard OIDC UserInfo.
    const url = new URL('https://kapi.kakao.com/v2/user/me');
    url.searchParams.set('secure_resource', 'true');
    const response = await providerFetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const result: unknown = await response.json().catch(() => null);
    if (!response.ok || !object(result))
      throw new Error('Kakao profile request failed');
    const account = object(result.kakao_account) ? result.kakao_account : null;
    const profile = account && object(account.profile) ? account.profile : null;
    return {
      displayName: text(profile?.nickname) ?? text(info.nickname),
      email:
        account?.is_email_valid === true && account.is_email_verified === true
          ? text(account.email)
          : info.email_verified === true
            ? text(info.email)
            : null,
      profileImageUrl:
        httpsUrl(profile?.profile_image_url) ??
        httpsUrl(profile?.thumbnail_image_url) ??
        httpsUrl(info.picture),
    };
  }
}
