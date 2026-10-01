import { performance } from 'node:perf_hooks'
import { channel } from 'node:diagnostics_channel'
import { createDatabaseClient } from './db-client.mjs'

const buckets = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 5, 10, 30, Infinity]
const counts = buckets.map(() => 0)
let sum = 0
const responses = { '1xx': 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 }
let queries = 0
let exceptions = 0
let database = null
let databaseSuccess = 0
channel('da-moa.db.query').subscribe(() => { queries++ })
channel('da-moa.api.exception').subscribe(() => { exceptions++ })

export async function collectDatabaseMetrics() {
  let client
  try {
    client = createDatabaseClient(process.env.DATABASE_URL || process.env.POSTGRES_URL, {
      instrument: false, connectionTimeoutMillis: 3000, query_timeout: 3000,
    })
    await client.connect()
    const { rows } = await client.query(`SELECT
      (SELECT count(*)::int FROM pg_stat_activity WHERE backend_type = 'client backend') AS used,
      current_setting('max_connections')::int - current_setting('superuser_reserved_connections')::int
        - COALESCE(current_setting('reserved_connections', true)::int, 0) AS capacity`)
    database = rows[0]
    databaseSuccess = 1
  } catch {
    database = null
    databaseSuccess = 0
  }
  finally { if (client) await client.end().catch(() => {}) }
}

export function trackHttpResponse(request, response) {
  const path = (request.url ?? '/').split('?')[0]
  if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket?.remoteAddress)) return
  if (/^\/(?:api\/health(?:\/|$)|internal(?:\/|$)|_next(?:\/|$))/.test(path) || /\.[^/]+$/.test(path)) return
  const started = performance.now()
  response.once('finish', () => {
    const seconds = (performance.now() - started) / 1000
    sum += seconds
    const statusClass = `${Math.floor(response.statusCode / 100)}xx`
    if (statusClass in responses) responses[statusClass]++
    for (let i = 0; i < buckets.length; i++) if (seconds <= buckets[i]) counts[i]++
  })
}

// ponytail: process-local counters cover one server; sum rates across instances before horizontal scaling.
export function httpMetrics() {
  const name = 'da_moa_http_request_duration_seconds'
  return [
    `# HELP ${name} Completed application HTTP response duration, excluding health checks and static assets.`,
    `# TYPE ${name} histogram`,
    ...buckets.map((bound, i) => `${name}_bucket{le="${bound === Infinity ? '+Inf' : bound}"} ${counts[i]}`),
    `${name}_sum ${sum}`,
    `${name}_count ${counts.at(-1)}`,
    '# HELP da_moa_http_responses_total Completed application HTTP responses by status class.',
    '# TYPE da_moa_http_responses_total counter',
    ...Object.entries(responses).map(([status, count]) => `da_moa_http_responses_total{status_class="${status}"} ${count}`),
    '# HELP da_moa_db_queries_total Application query() calls including failures and transaction statements; excludes metric probes.',
    '# TYPE da_moa_db_queries_total counter',
    `da_moa_db_queries_total ${queries}`,
    '# HELP da_moa_exceptions_total Unexpected API exceptions handled by errorResponse().',
    '# TYPE da_moa_exceptions_total counter',
    `da_moa_exceptions_total ${exceptions}`,
    '# HELP da_moa_db_metrics_success Whether the last PostgreSQL capacity probe succeeded.',
    '# TYPE da_moa_db_metrics_success gauge',
    `da_moa_db_metrics_success ${databaseSuccess}`,
    ...(database ? [
      '# HELP da_moa_db_connections_used PostgreSQL client backends including the monitoring connection.',
      '# TYPE da_moa_db_connections_used gauge',
      `da_moa_db_connections_used ${database.used}`,
      '# HELP da_moa_db_connections_available Remaining ordinary PostgreSQL connection slots excluding reserved connections.',
      '# TYPE da_moa_db_connections_available gauge',
      `da_moa_db_connections_available ${Math.max(0, database.capacity - database.used)}`,
    ] : []),
    '',
  ].join('\n')
}
