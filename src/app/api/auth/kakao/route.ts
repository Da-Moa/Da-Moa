import { NextRequest, NextResponse } from 'next/server'
import {
  authCookieOptions,
  createKakaoAuthorizationRequest,
  createReturnToCookie,
  getKakaoAuthenticationConfig,
  OIDC_COOKIE_NAMES,
  OIDC_MAX_AGE_SECONDS,
  RETURN_TO_COOKIE_NAME,
  safeReturnTo,
} from '../../../../lib/auth'

export const runtime = 'nodejs'

function loginRedirect(request: NextRequest, error: string) {
  const url = new URL('/login', request.url)
  url.searchParams.set('error', error)
  url.searchParams.set('returnTo', safeReturnTo(request.nextUrl.searchParams.get('returnTo')))
  const response = NextResponse.redirect(url)
  response.headers.set('Cache-Control', 'private, no-store')
  return response
}

export async function GET(request: NextRequest) {
  try {
    const login = createKakaoAuthorizationRequest(getKakaoAuthenticationConfig())
    const response = NextResponse.redirect(login.url)
    const options = authCookieOptions(OIDC_MAX_AGE_SECONDS)

    response.cookies.set(OIDC_COOKIE_NAMES.state, login.state, options)
    response.cookies.set(OIDC_COOKIE_NAMES.nonce, login.nonce, options)
    response.cookies.set(OIDC_COOKIE_NAMES.codeVerifier, login.codeVerifier, options)
    response.cookies.set(RETURN_TO_COOKIE_NAME, createReturnToCookie(request.nextUrl.searchParams.get('returnTo'), login.state), options)
    response.headers.set('Cache-Control', 'private, no-store')
    return response
  } catch {
    return loginRedirect(request, 'configuration')
  }
}
