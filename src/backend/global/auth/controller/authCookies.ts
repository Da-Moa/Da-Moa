import type { HttpResponse } from '../../apiPayload/httpContext';
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
  response: HttpResponse,
  session: Pick<AuthSession, 'refreshToken' | 'refreshMaxAge'>,
) {
  response.cookies.set(ACCESS_TOKEN_COOKIE_NAME, '', authCookieOptions(0));
  response.cookies.set(
    REFRESH_TOKEN_COOKIE_NAME,
    session.refreshToken,
    refreshCookieOptions(session.refreshMaxAge),
  );
}
export function clearReturnToCookie(response: HttpResponse) {
  response.cookies.set(RETURN_TO_COOKIE_NAME, '', authCookieOptions(0));
}
export function clearOidcCookies(response: HttpResponse) {
  for (const name of Object.values(OIDC_COOKIE_NAMES))
    response.cookies.set(name, '', authCookieOptions(0));
}
export function clearAuthCookies(
  response: HttpResponse,
  options: { returnTo?: boolean; oidc?: boolean } = {},
) {
  setAuthCookies(response, { refreshToken: '', refreshMaxAge: 0 });
  if (options.returnTo) clearReturnToCookie(response);
  if (options.oidc) clearOidcCookies(response);
}
