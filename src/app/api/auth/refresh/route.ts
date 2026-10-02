import { NextRequest, NextResponse } from 'next/server'
import {
  ACCESS_TOKEN_COOKIE_NAME,
  ACCESS_TOKEN_MAX_AGE_SECONDS,
  authCookieOptions,
  createAccessToken,
  createRefreshToken,
  currentTimestamp,
  readRefreshToken,
  REFRESH_TOKEN_COOKIE_NAME,
  REFRESH_TOKEN_MAX_AGE_SECONDS,
  refreshCookieOptions,
} from '../../../../lib/auth'
import { sameOrigin } from '../../../../lib/http'

export const runtime = 'nodejs'

function clearAuthCookies(response: NextResponse) {
  response.cookies.set(ACCESS_TOKEN_COOKIE_NAME, '', authCookieOptions(0))
  response.cookies.set(REFRESH_TOKEN_COOKIE_NAME, '', refreshCookieOptions(0))
}

function unauthorizedResponse() {
  const response = NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  clearAuthCookies(response)
  response.headers.set('Cache-Control', 'private, no-store')
  return response
}

function unavailableResponse() {
  const response = NextResponse.json({ error: 'refresh_unavailable' }, { status: 503 })
  response.headers.set('Cache-Control', 'private, no-store')
  return response
}

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: 'forbidden', message: '허용되지 않은 요청입니다' }, {
      status: 403, headers: { 'Cache-Control': 'private, no-store' },
    })
  }

  const token = request.cookies.get(REFRESH_TOKEN_COOKIE_NAME)?.value
  const refresh = readRefreshToken(token)
  if (!token || !refresh) return unauthorizedResponse()

  try {
    const now = currentTimestamp()
    const purpose = refresh.purpose ?? 'app'
    const remaining = (refresh.expiresAt ?? now) - now
    const refreshMaxAge = purpose === 'onboarding' ? remaining : REFRESH_TOKEN_MAX_AGE_SECONDS
    const accessMaxAge = Math.min(ACCESS_TOKEN_MAX_AGE_SECONDS, remaining)
    const nextRefreshToken = createRefreshToken(refresh.userId, refresh.sessionId, undefined, now, refreshMaxAge, purpose)
    const response = NextResponse.json({ data: { accessToken: createAccessToken(refresh.userId, refresh.sessionId, undefined, now, accessMaxAge, purpose) } })
    response.cookies.set(ACCESS_TOKEN_COOKIE_NAME, '', authCookieOptions(0))
    response.cookies.set(
      REFRESH_TOKEN_COOKIE_NAME,
      nextRefreshToken,
      refreshCookieOptions(refreshMaxAge),
    )
    response.headers.set('Cache-Control', 'private, no-store')
    return response
  } catch {
    return unavailableResponse()
  }
}
