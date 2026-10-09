import { Inject, Injectable } from '@nestjs/common';
import {
  getKakaoConfig,
  getKakaoRedirectUris,
  readRedirectUriCookie,
  readReturnToCookie,
  type KakaoProfile,
} from '../authUtil';
import { AuthService, type AuthSession } from './auth.service';
import { KakaoOidcClient } from './kakaoOidc.client';

export type KakaoCallbackCookies = {
  state?: string;
  nonce?: string;
  codeVerifier?: string;
  redirectUri?: string;
  returnTo?: string;
};
export type KakaoCallbackQuery = {
  code: string | null;
  state: string | null;
  error: string | null;
};
type CallbackResult =
  | { error: 'failed' | 'invalid'; returnTo: string }
  | { session: AuthSession; returnTo: string };

@Injectable()
export class KakaoAuthService {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(KakaoOidcClient) private readonly oidc: KakaoOidcClient,
  ) {}

  async complete(
    origin: URL | null,
    query: KakaoCallbackQuery,
    cookies: KakaoCallbackCookies,
  ): Promise<CallbackResult> {
    const failure = (error: 'failed' | 'invalid'): CallbackResult => ({
      error,
      returnTo: readReturnToCookie(cookies.returnTo, cookies.state),
    });
    const { code, state, error } = query;
    if (
      error ||
      !code ||
      !state ||
      !cookies.state ||
      !cookies.nonce ||
      !cookies.codeVerifier
    )
      return failure('failed');
    try {
      const redirectUri = readRedirectUriCookie(cookies.redirectUri, state);
      // Preserve logins started before the signed redirect-URI cookie existed.
      if (
        !redirectUri &&
        (cookies.redirectUri !== undefined ||
          getKakaoRedirectUris().length !== 1)
      )
        return failure('invalid');
      const config = getKakaoConfig(origin, redirectUri ?? undefined);
      const identity = await this.oidc.authenticate(config, code, state, {
        state: cookies.state,
        nonce: cookies.nonce,
        codeVerifier: cookies.codeVerifier,
      });
      if (!identity) return failure('invalid');
      const { accessToken, subject } = identity;
      let profile: KakaoProfile = {
        displayName: null,
        email: null,
        profileImageUrl: null,
      };
      try {
        profile = await this.oidc.profile(config, accessToken, subject);
      } catch {
        // A verified ID token is sufficient; profile data is optional.
      }
      const session = await this.auth.signInKakao(subject, profile);
      return { session, returnTo: readReturnToCookie(cookies.returnTo, state) };
    } catch {
      return failure('failed');
    }
  }
}
