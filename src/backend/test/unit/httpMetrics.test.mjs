import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { httpMetrics, trackHttpResponse } from '../../global/monitoring/httpMetrics.mjs'

test('HTTP 지표가 완료된 동적 요청을 집계하고 URL·사용자 라벨을 제외한다', async () => {
  for (const url of ['/api/health', '/api/health/live?x=1', '/internal/realtime', '/_next/static/main.js', '/favicon.ico']) {
    const response = new EventEmitter()
    trackHttpResponse({ url }, response)
    assert.equal(response.listenerCount('finish'), 0)
  }
  assert.match(httpMetrics(), /_count 0\n/)
  const internal = new EventEmitter()
  trackHttpResponse({ url: '/api/me', socket: { remoteAddress: '127.0.0.1' } }, internal)
  assert.equal(internal.listenerCount('finish'), 0)
  const response = new EventEmitter()
  trackHttpResponse({ url: '/api/groups/private-id?token=secret' }, response)
  assert.match(httpMetrics(), /_count 0\n/)
  await new Promise(resolve => setTimeout(resolve, 30))
  response.emit('finish')
  response.emit('finish')
  const metrics = httpMetrics()
  assert.match(metrics, /_count 1\n/)
  assert.match(metrics, /_bucket\{le="0.01"\} 0\n/)
  assert.match(metrics, /_bucket\{le="\+Inf"\} 1\n/)
  const sum = Number(metrics.match(/_sum (\S+)/)[1])
  assert.ok(sum >= 0.01)
  const bucketLines = [...metrics.matchAll(/_bucket\{le="([^"]+)"\} (\d+)/g)]
  for (const [, bound, count] of bucketLines) assert.equal(Number(count), sum <= Number(bound.replace('+Inf', 'Infinity')) ? 1 : 0)
  assert.doesNotMatch(metrics, /private-id|token|secret/)
  const page = new EventEmitter()
  trackHttpResponse({ url: '/home?view=groups' }, page)
  page.emit('finish')
  assert.match(httpMetrics(), /_count 2\n/)
  const aborted = new EventEmitter()
  trackHttpResponse({ url: '/api/me' }, aborted)
  aborted.emit('close')
  assert.match(httpMetrics(), /_count 2\n/)
})
