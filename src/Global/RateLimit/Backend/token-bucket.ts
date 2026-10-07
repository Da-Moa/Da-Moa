import { performance } from 'node:perf_hooks'
import { rateLimitPolicies, type RateLimitKind } from './rate-limit-policy.ts'

type Bucket = { tokens: number; updatedAt: number; fullAt: number }

export function createTokenBuckets(now = () => performance.now()) {
  const buckets = new Map<string, Bucket>()

  // No await: refill/check/debit of every applicable bucket is one synchronous operation.
  function consume(userId: string, kinds: RateLimitKind[]): number {
    const timestamp = now()
    const candidates = [...new Set(kinds)].map(kind => {
      const key = JSON.stringify([userId, kind])
      const { capacity, refillPerSecond } = rateLimitPolicies[kind]
      const previous = buckets.get(key)
      const tokens = previous ? Math.min(capacity, previous.tokens + Math.max(0, timestamp - previous.updatedAt) * refillPerSecond / 1000) : capacity
      return { key, tokens, capacity, refillPerSecond }
    })
    const retryAfter = Math.ceil(Math.max(0, ...candidates.map(bucket => (1 - bucket.tokens) / bucket.refillPerSecond)))
    if (retryAfter > 0) return retryAfter
    for (const { key, tokens, capacity, refillPerSecond } of candidates) {
      buckets.set(key, { tokens: tokens - 1, updatedAt: timestamp, fullAt: timestamp + (capacity - tokens + 1) / refillPerSecond * 1000 })
    }
    return 0
  }

  function prune() {
    const timestamp = now()
    for (const [key, bucket] of buckets) if (bucket.fullAt <= timestamp) buckets.delete(key)
  }
  return { consume, prune }
}
