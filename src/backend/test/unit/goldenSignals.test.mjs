import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { Client } from 'pg'
import { createDatabaseClient } from '../../global/database/dbClient.mjs'
import { collectDatabaseMetrics, httpMetrics, trackHttpResponse } from '../../global/monitoring/httpMetrics.mjs'
import { AppError } from '../../global/apiPayload/errors.ts'
import { errorResponse } from '../support/nativeResponseTestSupport.ts'

test('golden signal counters preserve query behavior and omit failed DB capacity samples', async t => {
  t.mock.method(Client.prototype, 'connect', async () => {})
  t.mock.method(Client.prototype, 'end', async () => {})
  let failure = false
  let receiver
  let argumentsSeen
  const query = t.mock.method(Client.prototype, 'query', function (...args) {
    receiver = this
    argumentsSeen = args
    if (failure) throw new Error('database unavailable')
    return Promise.resolve({ rows: [{ used: 5, capacity: 97 }] })
  })
  const original = process.env.DATABASE_URL
  process.env.DATABASE_URL = 'postgresql://test:test@localhost/metrics_test'
  t.after(() => { if (original === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = original })
  const client = createDatabaseClient(process.env.DATABASE_URL)
  const sql = 'SELECT $1'
  const params = [42]
  await client.query(sql, params)
  assert.equal(receiver, client)
  assert.deepEqual(argumentsSeen, [sql, params])
  assert.match(httpMetrics(), /da_moa_db_queries_total 1\n/)
  await collectDatabaseMetrics()
  assert.match(httpMetrics(), /da_moa_db_queries_total 1\n/)
  assert.match(httpMetrics(), /da_moa_db_connections_used 5\n/)
  assert.match(httpMetrics(), /da_moa_db_connections_available 92\n/)
  failure = true
  assert.throws(() => client.query(sql), /database unavailable/)
  await collectDatabaseMetrics()
  assert.match(httpMetrics(), /da_moa_db_queries_total 2\n/)
  assert.match(httpMetrics(), /da_moa_db_metrics_success 0\n/)
  assert.doesNotMatch(httpMetrics(), /da_moa_db_connections_(used|available)/)
  assert.equal(query.mock.callCount(), 4)
  for (const statusCode of [200, 404, 503]) {
    const response = new EventEmitter()
    response.statusCode = statusCode
    trackHttpResponse({ url: '/api/me' }, response)
    response.emit('finish')
    response.emit('finish')
  }
  assert.match(httpMetrics(), /_count 3\n/)
  for (const status of ['2xx', '4xx', '5xx']) assert.ok(httpMetrics().includes(`status_class="${status}"} 1\n`))
  const excluded = new EventEmitter()
  excluded.statusCode = 503
  trackHttpResponse({ url: '/api/health' }, excluded)
  excluded.emit('finish')
  assert.ok(httpMetrics().includes('status_class="5xx"} 1\n'))
  assert.equal(errorResponse(new AppError(400, 'invalid_input', 'invalid')).status, 400)
  t.mock.method(console, 'error', () => {})
  assert.equal(errorResponse(new Error('unexpected')).status, 503)
  assert.match(httpMetrics(), /da_moa_exceptions_total 1\n/)
  assert.doesNotMatch(httpMetrics(), /SELECT|unexpected|postgresql:|metrics_test/)
})
