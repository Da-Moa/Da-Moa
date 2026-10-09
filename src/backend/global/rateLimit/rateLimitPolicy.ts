export const rateLimitPolicies = {
  read: { capacity: 30, refillPerSecond: 3 },
  write: { capacity: 10, refillPerSecond: .5 },
  upload: { capacity: 3, refillPerSecond: 1 / 6 },
  refresh: { capacity: 5, refillPerSecond: 1 / 3 },
  websocket: { capacity: 3, refillPerSecond: 1 / 6 },
} as const

export type RateLimitKind = keyof typeof rateLimitPolicies

export function requestRateLimitKinds(method: string, pathname: string): RateLimitKind[] {
  if (method === 'POST' && ['/api/auth/access-token', '/api/auth/refresh'].includes(pathname)) return ['refresh']
  if (method === 'GET' || method === 'HEAD') return ['read']
  if (method === 'POST' && /^\/api\/rounds\/[^/]+\/expenses\/[^/]+\/receipts$/.test(pathname)) return ['write', 'upload']
  return ['write']
}
