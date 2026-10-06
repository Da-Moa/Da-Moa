import 'server-only'
import { clearAuthCookies } from '../Controller/AuthCookies'
import { NextResponse, type NextRequest } from 'next/server'
import {
  REFRESH_TOKEN_COOKIE_NAME,
  readRequestAccessToken, readRefreshToken,
} from '../auth-util'
import { AppError, errorResponse } from '../../../../lib/errors'

const publicHealthPaths = ['/api/health', '/api/health/live', '/api/health/database', '/api/health/minio', '/api/health/dependencies', '/api/health/worker', '/api/health/worker/readyz']

export function jwtGuard(request: NextRequest): Response | null {
  const { pathname } = request.nextUrl
  const method = request.method
  if ((method === 'GET' || method === 'HEAD') && publicHealthPaths.includes(pathname)) return null
  // Login establishes the first JWT; existing OIDC and local-only login guards apply.
  if ((method === 'GET' && pathname === '/api/auth/kakao') || (method === 'POST' && pathname === '/api/auth/test-login')) return null

  const refreshRequest = method === 'POST' && ['/api/auth/refresh', '/api/auth/access-token'].includes(pathname)
  const logoutRequest = method === 'POST' && pathname === '/api/auth/logout'
  const refresh = refreshRequest || logoutRequest ? readRefreshToken(request.cookies.get(REFRESH_TOKEN_COOKIE_NAME)?.value) : null
  const access = refreshRequest ? null : readRequestAccessToken(request)
  if (refresh || access) return null

  if (refreshRequest) {
    const response = NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: { 'Cache-Control': 'private, no-store' } })
    clearAuthCookies(response)
    return response
  }
  return errorResponse(new AppError(401, 'unauthorized', '로그인이 필요합니다'))
}
