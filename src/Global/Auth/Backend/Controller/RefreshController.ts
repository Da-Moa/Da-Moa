import 'server-only'
import { clearAuthCookies, setAuthCookies } from './AuthCookies'
import { refreshTokens } from '../Service/AuthService'
import { NextRequest, NextResponse } from 'next/server'
import { readRefreshToken, REFRESH_TOKEN_COOKIE_NAME } from '../auth-util'
import { sameOrigin } from '../../../../lib/http'

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

export async function getRefreshResponse(request: NextRequest) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: 'forbidden', message: '허용되지 않은 요청입니다' }, {
      status: 403, headers: { 'Cache-Control': 'private, no-store' },
    })
  }

  const token = request.cookies.get(REFRESH_TOKEN_COOKIE_NAME)?.value
  const refresh = readRefreshToken(token)
  if (!token || !refresh) return unauthorizedResponse()

  try {
    const session = refreshTokens(refresh)
    const response = NextResponse.json({ data: { accessToken: session.accessToken } })
    setAuthCookies(response, session)
    response.headers.set('Cache-Control', 'private, no-store')
    return response
  } catch {
    return unavailableResponse()
  }
}
