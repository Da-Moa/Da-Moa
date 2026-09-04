import { NextRequest, NextResponse } from 'next/server'
import {
  ACCESS_TOKEN_COOKIE_NAME,
  ACCESS_TOKEN_MAX_AGE_SECONDS,
  authCookieOptions,
  createAccessToken,
  currentTimestamp,
  hashRefreshToken,
  readRefreshToken,
  REFRESH_TOKEN_COOKIE_NAME,
  refreshCookieOptions,
} from '../../../../lib/auth'
import { isActiveRefreshToken } from '../../../../lib/auth-store'

export const runtime = 'nodejs'

function clearAuthCookies(response: NextResponse) {
  response.cookies.set(ACCESS_TOKEN_COOKIE_NAME, '', authCookieOptions(0))
  response.cookies.set(REFRESH_TOKEN_COOKIE_NAME, '', refreshCookieOptions(0))
}

function unauthorizedResponse() {
  const response = NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  clearAuthCookies(response)
  response.headers.set('Cache-Control', 'no-store')
  return response
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin')
  if (origin && origin !== request.nextUrl.origin) return unauthorizedResponse()

  const token = request.cookies.get(REFRESH_TOKEN_COOKIE_NAME)?.value
  const refresh = readRefreshToken(token)
  if (!token || !refresh) return unauthorizedResponse()

  try {
    const now = currentTimestamp()
    if (!(await isActiveRefreshToken(refresh.userId, refresh.sessionId, hashRefreshToken(token), now))) {
      return unauthorizedResponse()
    }

    const response = NextResponse.json({ ok: true })
    response.cookies.set(
      ACCESS_TOKEN_COOKIE_NAME,
      createAccessToken(refresh.userId, refresh.sessionId),
      authCookieOptions(ACCESS_TOKEN_MAX_AGE_SECONDS),
    )
    response.headers.set('Cache-Control', 'no-store')
    return response
  } catch {
    return unauthorizedResponse()
  }
}
