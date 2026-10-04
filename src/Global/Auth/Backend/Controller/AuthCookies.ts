import 'server-only'
import type { NextResponse } from 'next/server'
import { ACCESS_TOKEN_COOKIE_NAME, REFRESH_TOKEN_COOKIE_NAME, RETURN_TO_COOKIE_NAME, OIDC_COOKIE_NAMES, authCookieOptions, refreshCookieOptions } from '../auth-util'
import type { AuthSession } from '../Service/AuthService'

export function setAuthCookies(response: NextResponse, session: Pick<AuthSession, 'refreshToken' | 'refreshMaxAge'>) {
  response.cookies.set(ACCESS_TOKEN_COOKIE_NAME, '', authCookieOptions(0))
  response.cookies.set(REFRESH_TOKEN_COOKIE_NAME, session.refreshToken, refreshCookieOptions(session.refreshMaxAge))
}
export function clearReturnToCookie(response: NextResponse) {
  response.cookies.set(RETURN_TO_COOKIE_NAME, '', authCookieOptions(0))
}
export function clearOidcCookies(response: NextResponse) {
  for (const name of Object.values(OIDC_COOKIE_NAMES)) response.cookies.set(name, '', authCookieOptions(0))
}
export function clearAuthCookies(response: NextResponse, options: { returnTo?: boolean; oidc?: boolean } = {}) {
  setAuthCookies(response, { refreshToken: '', refreshMaxAge: 0 })
  if (options.returnTo) clearReturnToCookie(response)
  if (options.oidc) clearOidcCookies(response)
}
