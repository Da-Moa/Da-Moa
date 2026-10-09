import type { Response } from 'express';
import {
  ACCESS_TOKEN_COOKIE_NAME,
  REFRESH_TOKEN_COOKIE_NAME,
  RETURN_TO_COOKIE_NAME,
  OIDC_COOKIE_NAMES,
  authCookieOptions,
  refreshCookieOptions,
} from '../authUtil';
import type { AuthSession } from '../service/auth.service';

type CookieResponse = {
  cookies: {
    set(
      name: string,
      value: string,
      options: ReturnType<typeof authCookieOptions>,
    ): unknown;
  };
};

export function nativeCookieResponse(response: Response): CookieResponse {
  return {
    cookies: {
      set(name, value, options) {
        // App policy uses seconds; Express cookie maxAge uses milliseconds.
        response.cookie(name, value, {
          ...options,
          maxAge: options.maxAge * 1000,
        });
      },
    },
  };
}

export function setAuthCookies(
  response: CookieResponse,
  session: Pick<AuthSession, 'refreshToken' | 'refreshMaxAge'>,
) {
  response.cookies.set(ACCESS_TOKEN_COOKIE_NAME, '', authCookieOptions(0));
  response.cookies.set(
    REFRESH_TOKEN_COOKIE_NAME,
    session.refreshToken,
    refreshCookieOptions(session.refreshMaxAge),
  );
}
export function clearReturnToCookie(response: CookieResponse) {
  response.cookies.set(RETURN_TO_COOKIE_NAME, '', authCookieOptions(0));
}
export function clearOidcCookies(response: CookieResponse) {
  for (const name of Object.values(OIDC_COOKIE_NAMES))
    response.cookies.set(name, '', authCookieOptions(0));
}
export function clearAuthCookies(
  response: CookieResponse,
  options: { returnTo?: boolean; oidc?: boolean } = {},
) {
  setAuthCookies(response, { refreshToken: '', refreshMaxAge: 0 });
  if (options.returnTo) clearReturnToCookie(response);
  if (options.oidc) clearOidcCookies(response);
}
