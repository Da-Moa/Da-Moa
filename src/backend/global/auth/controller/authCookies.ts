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

export function setAuthCookies(
  response: Response,
  session: Pick<AuthSession, 'refreshToken' | 'refreshMaxAge'>,
) {
  response.cookie(ACCESS_TOKEN_COOKIE_NAME, '', authCookieOptions(0));
  response.cookie(
    REFRESH_TOKEN_COOKIE_NAME,
    session.refreshToken,
    refreshCookieOptions(session.refreshMaxAge),
  );
}
export function clearReturnToCookie(response: Response) {
  response.cookie(RETURN_TO_COOKIE_NAME, '', authCookieOptions(0));
}
export function clearOidcCookies(response: Response) {
  for (const name of Object.values(OIDC_COOKIE_NAMES))
    response.cookie(name, '', authCookieOptions(0));
}
export function clearAuthCookies(
  response: Response,
  options: { returnTo?: boolean; oidc?: boolean } = {},
) {
  setAuthCookies(response, { refreshToken: '', refreshMaxAge: 0 });
  if (options.returnTo) clearReturnToCookie(response);
  if (options.oidc) clearOidcCookies(response);
}
