import { randomUUID, timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import {
  ACCESS_TOKEN_COOKIE_NAME,
  ACCESS_TOKEN_MAX_AGE_SECONDS,
  authCookieOptions,
  createAccessToken,
  createRefreshToken,
  currentTimestamp,
  exchangeKakaoAuthorizationCode,
  getKakaoUserProfile,
  getKakaoConfig,
  hashRefreshToken,
  OIDC_COOKIE_NAMES,
  REFRESH_TOKEN_COOKIE_NAME,
  REFRESH_TOKEN_MAX_AGE_SECONDS,
  refreshCookieOptions,
  type KakaoProfile,
  verifyKakaoIdToken,
} from '../../../../lib/auth'
import { createRefreshSession, upsertKakaoUser } from '../../../../lib/auth-store'

export const runtime = 'nodejs'

function clearOidcCookies(response: NextResponse) {
  const options = authCookieOptions(0)
  Object.values(OIDC_COOKIE_NAMES).forEach((name) => response.cookies.set(name, '', options))
}

function loginRedirect(request: NextRequest, error: string) {
  const url = new URL('/login', request.url)
  url.searchParams.set('error', error)
  const response = NextResponse.redirect(url)
  clearOidcCookies(response)
  response.headers.set('Cache-Control', 'no-store')
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

    const issuedAt = currentTimestamp()
    const user = await upsertKakaoUser(subject, profile, issuedAt)
    const sessionId = randomUUID()
    const refreshToken = createRefreshToken(user.id, sessionId, undefined, issuedAt)
    await createRefreshSession({
      expiresAt: issuedAt + REFRESH_TOKEN_MAX_AGE_SECONDS,
      id: sessionId,
      issuedAt,
      tokenHash: hashRefreshToken(refreshToken),
      userId: user.id,
    })

    const response = NextResponse.redirect(new URL('/home', request.url))
    response.cookies.set(
      ACCESS_TOKEN_COOKIE_NAME,
      createAccessToken(user.id, sessionId, undefined, issuedAt),
      authCookieOptions(ACCESS_TOKEN_MAX_AGE_SECONDS),
    )
    response.cookies.set(
      REFRESH_TOKEN_COOKIE_NAME,
      refreshToken,
      refreshCookieOptions(REFRESH_TOKEN_MAX_AGE_SECONDS),
    )
    clearOidcCookies(response)
    response.headers.set('Cache-Control', 'no-store')
    return response
  } catch {
    return loginRedirect(request, 'failed')
  }
}
