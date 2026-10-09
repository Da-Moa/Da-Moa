import type { TokenService } from './service/token.service'

const publicHealthPaths = ['/api/health', '/api/health/live', '/api/health/database', '/api/health/minio', '/api/health/dependencies', '/api/health/worker', '/api/health/worker/readyz']

export function apiJwtPolicy(method: string, pathname: string) {
  if (method === 'GET' && pathname === '/auth/v1/kakao') return 'public'
  if ((method === 'GET' || method === 'HEAD') && publicHealthPaths.includes(pathname)) return 'public'
  if (method === 'GET' && pathname === '/api/auth/kakao' || method === 'POST' && pathname === '/api/auth/test-login') return 'public'
  if (method === 'POST' && ['/api/auth/refresh', '/api/auth/access-token'].includes(pathname)) return 'refresh'
  if (method === 'POST' && pathname === '/api/auth/logout') return 'logout'
  return 'access'
}

export function readApiJwt(tokens: TokenService, method: string, pathname: string, authorization?: string | null, refreshCookie?: string) {
  const policy = apiJwtPolicy(method, pathname)
  if (policy === 'public') return null
  const refresh = policy === 'refresh' || policy === 'logout' ? tokens.verifyRefreshToken(refreshCookie) : null
  if (policy === 'refresh') return refresh
  return refresh ?? tokens.verifyAccessToken(authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined)
}
