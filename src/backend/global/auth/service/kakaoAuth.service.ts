import { Inject, Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import {
  exchangeKakaoAuthorizationCode,
  getKakaoConfig,
  getKakaoRedirectUris,
  getKakaoUserProfile,
  readRedirectUriCookie,
  readReturnToCookie,
  verifyKakaoIdToken,
  type KakaoProfile,
} from '../authUtil';
import { AuthService, type AuthSession } from './auth.service';

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
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

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
    const actual = Buffer.from(state),
      expected = Buffer.from(cookies.state);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return failure('invalid');
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
      const { accessToken, idToken } = await exchangeKakaoAuthorizationCode(
        config,
        code,
        cookies.codeVerifier,
      );
      const subject = await verifyKakaoIdToken(idToken, config, cookies.nonce);
      if (!subject) return failure('invalid');
      let profile: KakaoProfile = {
        displayName: null,
        email: null,
        profileImageUrl: null,
      };
      try {
        profile = await getKakaoUserProfile(accessToken, subject);
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
