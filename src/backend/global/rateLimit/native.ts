import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { setInterval, clearInterval } from 'node:timers'
import { apiJwtPolicy, readApiJwt, readAccessToken, REFRESH_TOKEN_COOKIE_NAME } from '../auth/native.ts'
import { createTokenBuckets } from './tokenBucket.ts'
import { requestRateLimitKinds } from './rateLimitPolicy.ts'
import { rateLimitResponse } from './rateLimitResponse.ts'

export { createTokenBuckets } from './tokenBucket.ts'
export { rateLimitPolicies, requestRateLimitKinds } from './rateLimitPolicy.ts'

function refreshCookie(cookie = '') {
  let value: string | undefined
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    if (part.slice(0, separator).trim() !== REFRESH_TOKEN_COOKIE_NAME) continue
    try { value = decodeURIComponent(part.slice(separator + 1).trim()) }
    catch { value = undefined }
  }
  return value
}

export function createRateLimitController(buckets = createTokenBuckets()) {
  // ponytail: one store per Node server; use an atomic shared store before running multiple processes/instances.
  const cleanup = setInterval(buckets.prune, 60000)
  cleanup.unref()

  function handleRequest(request: IncomingMessage, response: ServerResponse) {
    let pathname: string
    try { pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname).replace(/\/{2,}/g, '/').replace(/\/+$/, '') }
    catch { return false }
    if (pathname !== '/api' && !pathname.startsWith('/api/')) return false
    const method = request.method ?? 'GET'
    if (apiJwtPolicy(method, pathname) === 'public') return false
    const jwt = readApiJwt(method, pathname, request.headers.authorization, refreshCookie(request.headers.cookie))
    // Invalid JWTs continue to the existing Proxy guard's 401/cookie cleanup response.
    if (!jwt) return false
    const retryAfter = buckets.consume(jwt.userId, requestRateLimitKinds(method, pathname))
    if (!retryAfter) return false
    const rejected = rateLimitResponse(retryAfter)
    response.writeHead(rejected.status, rejected.headers)
    response.end(method === 'HEAD' ? undefined : rejected.body)
    return true
  }

  function limitWebsocket(token: string | null, socket: Duplex) {
    const access = readAccessToken(token ?? undefined)
    if (!access || (access.purpose ?? 'app') !== 'app') { socket.destroy(); return true }
    const retryAfter = buckets.consume(access.userId, ['websocket'])
    if (!retryAfter) return false
    socket.end(`HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${retryAfter}\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    return true
  }

  return { handleRequest, limitWebsocket, close: () => clearInterval(cleanup) }
}
