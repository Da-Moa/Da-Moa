import 'server-only'
import { clearAuthCookies } from '../Controller/AuthCookies'
import { NextResponse, type NextRequest } from 'next/server'
import { REFRESH_TOKEN_COOKIE_NAME } from '../auth-util'
import { apiJwtPolicy, readApiJwt } from '../api-jwt-util'
import { AppError, errorResponse } from '../../../../lib/errors'

export function jwtGuard(request: NextRequest): Response | null {
  const { pathname } = request.nextUrl
  const method = request.method
  const policy = apiJwtPolicy(method, pathname)
  if (policy === 'public') return null
  if (readApiJwt(method, pathname, request.headers.get('authorization'), request.cookies.get(REFRESH_TOKEN_COOKIE_NAME)?.value)) return null

  if (policy === 'refresh') {
    const response = NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: { 'Cache-Control': 'private, no-store' } })
    clearAuthCookies(response)
    return response
  }
  return errorResponse(new AppError(401, 'unauthorized', '로그인이 필요합니다'))
}
