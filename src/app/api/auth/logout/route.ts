import { NextRequest, NextResponse } from 'next/server'
import {
  ACCESS_TOKEN_COOKIE_NAME,
  authCookieOptions,
  readAccessToken,
  readRefreshToken,
  REFRESH_TOKEN_COOKIE_NAME,
  refreshCookieOptions,
} from '../../../../lib/auth'
import { deleteRefreshSession } from '../../../../lib/auth-store'

export const runtime = 'nodejs'

function clearAuthCookies(response: NextResponse) {
  response.cookies.set(ACCESS_TOKEN_COOKIE_NAME, '', authCookieOptions(0))
  response.cookies.set(REFRESH_TOKEN_COOKIE_NAME, '', refreshCookieOptions(0))
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin')
  if (origin && origin !== request.nextUrl.origin) {
    const response = NextResponse.json({ error: 'forbidden' }, { status: 403 })
    response.headers.set('Cache-Control', 'no-store')
    return response
  }

  const refresh = readRefreshToken(request.cookies.get(REFRESH_TOKEN_COOKIE_NAME)?.value)
  const access = readAccessToken(request.cookies.get(ACCESS_TOKEN_COOKIE_NAME)?.value)
  const session = refresh ?? access

  if (session) {
    try {
      await deleteRefreshSession(session.userId, session.sessionId)
    } catch {
      const response = NextResponse.json({ error: 'logout_unavailable' }, { status: 503 })
      response.headers.set('Cache-Control', 'no-store')
      return response
    }
  }

  const response = NextResponse.json({ ok: true })
  clearAuthCookies(response)
  response.headers.set('Cache-Control', 'no-store')
  return response
}
