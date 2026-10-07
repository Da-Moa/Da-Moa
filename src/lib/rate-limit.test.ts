import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { proxy } from '../proxy'
import { createAccessToken, createRefreshToken, REFRESH_TOKEN_COOKIE_NAME } from './auth'
import { createRateLimitController, createTokenBuckets, rateLimitPolicies, requestRateLimitKinds } from '../Global/RateLimit/Backend/native'

test('token buckets isolate users/kinds, refill fractionally, debit atomically and prune only fully refilled entries', async () => {
  let time = 0
  const buckets = createTokenBuckets(() => time)
  for (const kind of Object.keys(rateLimitPolicies) as (keyof typeof rateLimitPolicies)[]) {
    const { capacity, refillPerSecond } = rateLimitPolicies[kind]
    for (let i = 0; i < capacity; i++) assert.equal(buckets.consume(kind, [kind]), 0)
    assert.equal(buckets.consume(kind, [kind]), Math.ceil(1 / refillPerSecond))
  }
  time = 1000
  assert.equal(buckets.consume('write', ['write']), 1)
  time = 2000
  assert.equal(buckets.consume('write', ['write']), 0)
  assert.equal(buckets.consume('write', ['write']), 2)
  assert.equal(buckets.consume('other-user', ['write']), 0)
  assert.equal(buckets.consume('write', ['read']), 0)

  const concurrent = await Promise.all(Array.from({ length: 25 }, async () => buckets.consume('concurrent', ['write'])))
  assert.equal(concurrent.filter(result => result === 0).length, 10)
  assert.equal(concurrent.filter(result => result === 2).length, 15)

  for (let i = 0; i < 3; i++) assert.equal(buckets.consume('upload-combined', ['write', 'upload']), 0)
  assert.equal(buckets.consume('upload-combined', ['write', 'upload']), 6)
  for (let i = 0; i < 7; i++) assert.equal(buckets.consume('upload-combined', ['write']), 0, 'denied upload must not debit write')
  assert.equal(buckets.consume('upload-combined', ['write']), 2)
  for (let i = 0; i < 10; i++) buckets.consume('write-full', ['write'])
  assert.equal(buckets.consume('write-full', ['write', 'upload']), 2)
  time += 2000
  for (let i = 0; i < 3; i++) assert.equal(buckets.consume('write-full', ['upload']), 0, 'denied combined request must not debit upload')
  buckets.prune()
  assert.equal(buckets.consume('write-full', ['upload']), 6, 'pruning an unfilled bucket must not reset its quota')
  time += 60000
  buckets.prune()
  for (let i = 0; i < 10; i++) assert.equal(buckets.consume('concurrent', ['write']), 0)

  assert.deepEqual(requestRateLimitKinds('POST', '/api/rounds/a/expenses/b/receipts'), ['write', 'upload'])
  assert.deepEqual(requestRateLimitKinds('DELETE', '/api/rounds/a/expenses/b/receipts/c'), ['write'])
  assert.deepEqual(requestRateLimitKinds('POST', '/api/auth/refresh'), ['refresh'])
  assert.deepEqual(requestRateLimitKinds('POST', '/api/auth/access-token'), ['refresh'])
  assert.deepEqual(requestRateLimitKinds('HEAD', '/api/me'), ['read'])
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) assert.deepEqual(requestRateLimitKinds(method, '/api/me'), ['write'])
})

test('native HTTP guard limits before Controller, shares JWT identities and returns retry metadata without clearing cookies', { timeout: 10000 }, async () => {
  const previous = process.env.AUTH_JWT_SECRET
  process.env.AUTH_JWT_SECRET = 'isolated-rate-limit-test-secret-at-least-32-bytes'
  let time = 0
  let calls = 0
  const buckets = createTokenBuckets(() => time)
  const limiter = createRateLimitController(buckets)
  const server = createServer((request, response) => {
    if (limiter.handleRequest(request, response)) return
    const guarded = proxy(new NextRequest(`http://localhost${request.url}`, {
      method: request.method, headers: { authorization: request.headers.authorization ?? '', cookie: request.headers.cookie ?? '' },
    }))
    if (guarded.status === 401) { response.writeHead(401).end(); return }
    calls++
    response.writeHead(200).end()
  })
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const access = createAccessToken('a', 'first')
    const request = (path: string, method = 'GET', token = access, cookie = '') => fetch(`${origin}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, cookie, 'x-user-id': 'spoofed' },
    })
    assert.equal((await request('/api/me', 'POST', 'invalid')).status, 401)
    assert.equal(calls, 0)
    for (let i = 0; i < 10; i++) assert.equal((await request(i % 2 ? '/api/groups' : '/api/me/bank-account', i % 2 ? 'POST' : 'PUT')).status, 200)
    const denied = await request('/api/me', 'PATCH', createAccessToken('a', 'another-device'))
    assert.equal(denied.status, 429)
    assert.equal(denied.headers.get('Retry-After'), '2')
    assert.equal(denied.headers.get('Cache-Control'), 'private, no-store')
    assert.equal(denied.headers.get('set-cookie'), null)
    assert.deepEqual(await denied.json(), { error: 'rate_limited', message: '요청이 많아요. 2초 후 다시 시도해 주세요.', details: { retryAfterSeconds: 2 } })
    assert.equal(calls, 10, '429 must never enter Controller')
    assert.equal((await request('/api/me', 'POST', 'invalid')).status, 401, 'invalid JWT still gets 401 after a user is throttled')
    assert.equal((await request('/api/me', 'POST', createAccessToken('b', 'other'))).status, 200)
    assert.equal((await request('/api/me')).status, 200, 'read and write are separate')
    for (let i = 0; i < 29; i++) await request('/api/groups')
    const head = await request('/api/me', 'HEAD')
    assert.equal(head.status, 429)
    assert.equal(await head.text(), '')
    assert.equal((await request('/api/health/live')).status, 200, 'health probes do not consume user tokens')

    const refresh = `${REFRESH_TOKEN_COOKIE_NAME}=${createRefreshToken('a', 'refresh')}`
    for (let i = 0; i < 5; i++) assert.equal((await request(i % 2 ? '/api/auth/refresh' : '/api/auth/access-token', 'POST', 'invalid', refresh)).status, 200)
    assert.equal((await request('/api/auth/refresh', 'POST', 'invalid', refresh)).status, 429)
    assert.equal((await request('/api/auth/refresh', 'POST', access)).status, 401)
    time = 3000
    assert.equal((await request('/api/auth/refresh', 'POST', 'invalid', refresh)).status, 200)

    const uploadToken = createAccessToken('upload-user', 'session')
    for (let i = 0; i < 3; i++) assert.equal((await request('/api/rounds/a/expenses/b/receipts', 'POST', uploadToken)).status, 200)
    const encoded = await request('/api/rounds/a/expenses/b/%72eceipts/', 'POST', uploadToken)
    assert.equal(encoded.status, 429, 'encoded/trailing-slash paths cannot bypass upload quota')
    assert.equal(encoded.headers.get('Retry-After'), '6')

    for (let i = 0; i < 3; i++) assert.equal(buckets.consume('socket-user', ['websocket']), 0)
    const socket = new PassThrough()
    let rejection = ''
    socket.on('data', bytes => { rejection += bytes })
    assert.equal(limiter.limitWebsocket(createAccessToken('socket-user', 'session'), socket), true)
    assert.match(rejection, /^HTTP\/1.1 429/)
    assert.match(rejection, /Retry-After: 6/)
    const invalidSocket = new PassThrough()
    assert.equal(limiter.limitWebsocket('invalid', invalidSocket), true)
    assert.equal(invalidSocket.destroyed, true)
  } finally {
    limiter.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
    if (previous === undefined) delete process.env.AUTH_JWT_SECRET
    else process.env.AUTH_JWT_SECRET = previous
  }
})
