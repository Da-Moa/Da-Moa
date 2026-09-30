import { performance } from 'node:perf_hooks'

const buckets = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 5, 10, 30, Infinity]
const counts = buckets.map(() => 0)
let sum = 0

export function trackHttpResponse(request, response) {
  const path = (request.url ?? '/').split('?')[0]
  if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket?.remoteAddress)) return
  if (/^\/(?:api\/health(?:\/|$)|internal(?:\/|$)|_next(?:\/|$))/.test(path) || /\.[^/]+$/.test(path)) return
  const started = performance.now()
  response.once('finish', () => {
    const seconds = (performance.now() - started) / 1000
    sum += seconds
    for (let i = 0; i < buckets.length; i++) if (seconds <= buckets[i]) counts[i]++
  })
}

// ponytail: one unlabeled histogram covers this single instance; add route groups when separate latency budgets are needed.
export function httpMetrics() {
  const name = 'da_moa_http_request_duration_seconds'
  return [
    `# HELP ${name} Completed application HTTP response duration, excluding health checks and static assets.`,
    `# TYPE ${name} histogram`,
    ...buckets.map((bound, i) => `${name}_bucket{le="${bound === Infinity ? '+Inf' : bound}"} ${counts[i]}`),
    `${name}_sum ${sum}`,
    `${name}_count ${counts.at(-1)}`,
    '',
  ].join('\n')
}
