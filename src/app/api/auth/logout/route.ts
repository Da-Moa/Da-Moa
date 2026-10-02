import { NextRequest, NextResponse } from 'next/server'
import {
  ACCESS_TOKEN_COOKIE_NAME,
  authCookieOptions,
  REFRESH_TOKEN_COOKIE_NAME,
  RETURN_TO_COOKIE_NAME,
  refreshCookieOptions,
} from '../../../../lib/auth'
import { sameOrigin } from '../../../../lib/http'

export const runtime = 'nodejs'

function clearAuthCookies(response: NextResponse) {
  response.cookies.set(ACCESS_TOKEN_COOKIE_NAME, '', authCookieOptions(0))
  response.cookies.set(REFRESH_TOKEN_COOKIE_NAME, '', refreshCookieOptions(0))
  response.cookies.set(RETURN_TO_COOKIE_NAME, '', authCookieOptions(0))
}

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) {
    const response = NextResponse.json({ error: 'forbidden' }, { status: 403 })
    response.headers.set('Cache-Control', 'private, no-store')
    return response
  }

  const response = NextResponse.json({ ok: true })
  clearAuthCookies(response)
  response.headers.set('Cache-Control', 'private, no-store')
  return response
}
