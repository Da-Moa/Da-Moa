import { timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import {
  ACCESS_TOKEN_COOKIE_NAME,
  authCookieOptions,
  createReturnToCookie,
  exchangeKakaoAuthorizationCode,
  getKakaoUserProfile,
  getKakaoConfig,
  ONBOARDING_MAX_AGE_SECONDS,
  OIDC_COOKIE_NAMES,
  REFRESH_TOKEN_COOKIE_NAME,
  RETURN_TO_COOKIE_NAME,
  readReturnToCookie,
  refreshCookieOptions,
  type KakaoProfile,
  verifyKakaoIdToken,
} from '../../../../lib/auth'
import { signInKakao } from '../../../../lib/auth-store'

export const runtime = 'nodejs'

function clearOidcCookies(response: NextResponse) {
  const options = authCookieOptions(0)
  Object.values(OIDC_COOKIE_NAMES).forEach((name) => response.cookies.set(name, '', options))
}

function loginRedirect(request: NextRequest, error: string) {
  const url = new URL('/login', request.url)
  url.searchParams.set('error', error)
  url.searchParams.set('returnTo', readReturnToCookie(request.cookies.get(RETURN_TO_COOKIE_NAME)?.value, request.cookies.get(OIDC_COOKIE_NAMES.state)?.value))
  const response = NextResponse.redirect(url)
  clearOidcCookies(response)
  response.headers.set('Cache-Control', 'private, no-store')
  return response
}

export async function GET(request: NextRequest) {
  const providerError = request.nextUrl.searchParams.get('error')
  const code = request.nextUrl.searchParams.get('code')
  const state = request.nextUrl.searchParams.get('state')
  const expectedState = request.cookies.get(OIDC_COOKIE_NAMES.state)?.value
  const expectedNonce = request.cookies.get(OIDC_COOKIE_NAMES.nonce)?.value
  const codeVerifier = request.cookies.get(OIDC_COOKIE_NAMES.codeVerifier)?.value

  if (providerError || !code || !state || !expectedState || !expectedNonce || !codeVerifier) {
    return loginRedirect(request, 'failed')
  }

  const stateBuffer = Buffer.from(state)
  const expectedStateBuffer = Buffer.from(expectedState)
  const stateMatches = stateBuffer.length === expectedStateBuffer.length
    && timingSafeEqual(stateBuffer, expectedStateBuffer)
  if (!stateMatches) return loginRedirect(request, 'invalid')

  try {
    const config = getKakaoConfig()
    const { accessToken, idToken } = await exchangeKakaoAuthorizationCode(config, code, codeVerifier)
    const subject = await verifyKakaoIdToken(idToken, config, expectedNonce)
    if (!subject) return loginRedirect(request, 'invalid')

    let profile: KakaoProfile = {
      displayName: null,
      email: null,
      profileImageUrl: null,
    }
    try {
      profile = await getKakaoUserProfile(accessToken, subject)
    } catch {
      // A verified ID token is sufficient to sign in; profile data is optional.
    }

    const session = await signInKakao(subject, profile)
    const returnTo = readReturnToCookie(request.cookies.get(RETURN_TO_COOKIE_NAME)?.value, state)
    const destination = session.purpose === 'onboarding' ? `/onboarding?returnTo=${encodeURIComponent(returnTo)}` : returnTo
    const response = NextResponse.redirect(new URL(destination, request.url))
    response.cookies.set(
      ACCESS_TOKEN_COOKIE_NAME,
      session.accessToken,
      authCookieOptions(session.accessMaxAge),
    )
    response.cookies.set(
      REFRESH_TOKEN_COOKIE_NAME,
      session.refreshToken,
      refreshCookieOptions(session.refreshMaxAge),
    )
    response.cookies.set(RETURN_TO_COOKIE_NAME,
      session.purpose === 'onboarding' ? createReturnToCookie(returnTo, state) : '',
      authCookieOptions(session.purpose === 'onboarding' ? ONBOARDING_MAX_AGE_SECONDS : 0))
    clearOidcCookies(response)
    response.headers.set('Cache-Control', 'private, no-store')
    return response
  } catch {
    return loginRedirect(request, 'failed')
  }
}
