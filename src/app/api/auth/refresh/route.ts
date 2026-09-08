import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import {
  ACCESS_TOKEN_COOKIE_NAME,
  ACCESS_TOKEN_MAX_AGE_SECONDS,
  authCookieOptions,
  createAccessToken,
  createRefreshToken,
  currentTimestamp,
  hashRefreshToken,
  readRefreshToken,
  REFRESH_TOKEN_COOKIE_NAME,
  REFRESH_TOKEN_MAX_AGE_SECONDS,
  refreshCookieOptions,
} from '../../../../lib/auth'
import { rotateRefreshSession } from '../../../../lib/auth-store'

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
  const origin = request.headers.get('origin')
  if (origin !== request.nextUrl.origin) {
    return NextResponse.json({ error: 'forbidden', message: '허용되지 않은 요청입니다' }, {
      status: 403, headers: { 'Cache-Control': 'private, no-store' },
    })
  }

  const token = request.cookies.get(REFRESH_TOKEN_COOKIE_NAME)?.value
  const refresh = readRefreshToken(token)
  if (!token || !refresh) return unauthorizedResponse()

  try {
    const now = currentTimestamp()
    const sessionId = randomUUID()
    const nextRefreshToken = createRefreshToken(refresh.userId, sessionId, undefined, now)
    if (!(await rotateRefreshSession({
      expiresAt: now + REFRESH_TOKEN_MAX_AGE_SECONDS,
      id: sessionId,
      issuedAt: now,
      now,
      previousSessionId: refresh.sessionId,
      previousTokenHash: hashRefreshToken(token),
      tokenHash: hashRefreshToken(nextRefreshToken),
      userId: refresh.userId,
    }))) {
      return unauthorizedResponse()
    }

    const response = NextResponse.json({ ok: true })
    response.cookies.set(
      ACCESS_TOKEN_COOKIE_NAME,
      createAccessToken(refresh.userId, sessionId, undefined, now),
      authCookieOptions(ACCESS_TOKEN_MAX_AGE_SECONDS),
    )
    response.cookies.set(
      REFRESH_TOKEN_COOKIE_NAME,
      nextRefreshToken,
      refreshCookieOptions(REFRESH_TOKEN_MAX_AGE_SECONDS),
    )
    response.headers.set('Cache-Control', 'private, no-store')
    return response
  } catch {
    return unavailableResponse()
  }
}
