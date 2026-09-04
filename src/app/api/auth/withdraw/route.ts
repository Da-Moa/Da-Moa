import { NextRequest, NextResponse } from 'next/server'
import {
  ACCESS_TOKEN_COOKIE_NAME,
  authCookieOptions,
  currentTimestamp,
  OIDC_COOKIE_NAMES,
  readAccessToken,
  REFRESH_TOKEN_COOKIE_NAME,
  refreshCookieOptions,
} from '../../../../lib/auth'
import { deleteUser, isActiveSession } from '../../../../lib/auth-store'

export const runtime = 'nodejs'

function clearAuthCookies(response: NextResponse) {
  response.cookies.set(ACCESS_TOKEN_COOKIE_NAME, '', authCookieOptions(0))
  response.cookies.set(REFRESH_TOKEN_COOKIE_NAME, '', refreshCookieOptions(0))
  Object.values(OIDC_COOKIE_NAMES).forEach((name) => response.cookies.set(name, '', authCookieOptions(0)))
}

function unauthorizedResponse() {
  const response = NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  clearAuthCookies(response)
  response.headers.set('Cache-Control', 'no-store')
  return response
}

export async function POST(request: NextRequest) {
  if (request.headers.get('origin') !== request.nextUrl.origin) {
    const response = NextResponse.json({ error: 'forbidden' }, { status: 403 })
    response.headers.set('Cache-Control', 'no-store')
    return response
  }

  const access = readAccessToken(request.cookies.get(ACCESS_TOKEN_COOKIE_NAME)?.value)
  if (!access) return unauthorizedResponse()

  try {
    const now = currentTimestamp()
    if (!(await isActiveSession(access.userId, access.sessionId, now))) return unauthorizedResponse()
    if (!(await deleteUser(access.userId))) return unauthorizedResponse()
  } catch {
    const response = NextResponse.json({ error: 'withdrawal_unavailable' }, { status: 503 })
    response.headers.set('Cache-Control', 'no-store')
    return response
  }

  const response = NextResponse.json({ ok: true })
  clearAuthCookies(response)
  response.headers.set('Cache-Control', 'no-store')
  return response
}
