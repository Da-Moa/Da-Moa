import { NextRequest, NextResponse } from 'next/server'
import {
  authCookieOptions,
  createKakaoAuthorizationRequest,
  getKakaoAuthenticationConfig,
  OIDC_COOKIE_NAMES,
  OIDC_MAX_AGE_SECONDS,
} from '../../../../lib/auth'

export const runtime = 'nodejs'

function loginRedirect(request: NextRequest, error: string) {
  const url = new URL('/login', request.url)
  url.searchParams.set('error', error)
  const response = NextResponse.redirect(url)
  response.headers.set('Cache-Control', 'no-store')
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
    response.headers.set('Cache-Control', 'no-store')
    return response
  } catch {
    return loginRedirect(request, 'configuration')
  }
}
