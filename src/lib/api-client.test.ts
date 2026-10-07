import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { apiRequest, ApiError } from './api-client.ts'
import { createRoundRequest } from '../Domain/Settle/Frontend/Requests.ts'
import { createGroupRequest } from '../Domain/Group/Frontend/Requests.ts'
import { discardBankAccountRequests } from '../Domain/User/Frontend/Requests.ts'

const originalFetch = globalThis.fetch
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!
afterEach(() => {
  discardBankAccountRequests()
  globalThis.fetch = originalFetch
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
  Object.defineProperty(globalThis, 'crypto', originalCrypto)
})

test('429 preserves the original mutation key/body across a lost response and a manual retry', async () => {
  fakeWindow()
  const requests: { key: string | null; body: BodyInit | null | undefined }[] = []
  globalThis.fetch = async (_input, init) => {
    requests.push({ key: new Headers(init?.headers).get('Idempotency-Key'), body: init?.body })
    if (requests.length === 1) return Response.json({ error: 'transaction_retry' }, { status: 503 })
    if (requests.length === 2) return Response.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '2' } })
    return Response.json({ data: { id: 'saved' } })
  }
  const path = '/api/rounds/rate-limited/expenses'
  await assert.rejects(() => apiRequest(path, { method: 'POST', body: { amount: '100', expectedVersion: 1 } }))
  await assert.rejects(() => apiRequest(path, { method: 'POST', body: { amount: '100', expectedVersion: 2 } }), error => error instanceof ApiError && error.status === 429 && error.retryAfterSeconds === 2)
  assert.equal(requests.length, 2, 'writes are never retried automatically')
  await apiRequest(path, { method: 'POST', body: { amount: '100', expectedVersion: 3 } })
  assert.deepEqual(requests[1], requests[0])
  assert.deepEqual(requests[2], requests[0])
})

test('rate-limited GET waits for Retry-After and retries once, sharing the pending read', async t => {
  fakeWindow()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  globalThis.fetch = async () => ++calls === 1
    ? Response.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '2' } })
    : Response.json({ data: { version: 2 } })
  const pending = apiRequest('/api/rounds/rate-limited-read')
  assert.equal(apiRequest('/api/rounds/rate-limited-read'), pending)
  await new Promise(resolve => setImmediate(resolve))
  t.mock.timers.tick(1999)
  assert.equal(calls, 1)
  t.mock.timers.tick(1)
  assert.deepEqual(await pending, { version: 2 })
  assert.equal(calls, 2)
})

test('refresh throttling keeps authentication and mutation key, with actionable 429 metadata', async () => {
  const redirects = fakeWindow()
  const keys: (string | null)[] = []
  globalThis.fetch = async (input, init) => {
    if (String(input) === '/api/auth/refresh') return Response.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '3' } })
    keys.push(new Headers(init?.headers).get('Idempotency-Key'))
    return keys.length === 1 ? Response.json({ error: 'unauthorized' }, { status: 401 }) : Response.json({ data: { ok: true } })
  }
  const options = { method: 'POST', body: { expectedVersion: 1 } }
  await assert.rejects(() => apiRequest('/api/rounds/throttled-refresh/confirm', options), error => error instanceof ApiError && error.status === 429 && error.code === 'rate_limited' && error.retryAfterSeconds === 3)
  assert.deepEqual(redirects, [])
  assert.equal(window.localStorage.getItem('da_moa_access'), 'test-access-token')
  await apiRequest('/api/rounds/throttled-refresh/confirm', options)
  assert.equal(keys[0], keys[1])
})

test('GET retries stop after one 429 retry and an aborted wait makes no second request', async t => {
  fakeWindow()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  globalThis.fetch = async () => { calls++; return Response.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '1' } }) }
  const pending = apiRequest('/api/rounds/bounded-rate-retry')
  await new Promise(resolve => setImmediate(resolve))
  t.mock.timers.tick(1000)
  await assert.rejects(() => pending, error => error instanceof ApiError && error.status === 429)
  assert.equal(calls, 2)
  const controller = new AbortController()
  const aborted = apiRequest('/api/rounds/aborted-rate-retry', { signal: controller.signal })
  const rejected = assert.rejects(() => aborted, error => error instanceof DOMException && error.name === 'AbortError')
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await rejected
  t.mock.timers.tick(60000)
  assert.equal(calls, 3)
})

test('HTTP LAN mutations and receipt retries work without randomUUID or subtle, while changed file bytes stay blocked', async () => {
  fakeWindow()
  const requests: { key: string; body: FormData | undefined }[] = []
  globalThis.fetch = async (_input, init) => {
    requests.push({ key: new Headers(init?.headers).get('Idempotency-Key')!, body: init?.body instanceof FormData ? init.body : undefined })
    return requests.length === 1 ? Response.json({ error: 'transaction_retry' }, { status: 503 }) : Response.json({ data: { id: 'saved' } })
  }
  const form = (content: string, version: string) => {
    const body = new FormData()
    body.set('file', new File([content], 'receipt.png', { type: 'image/png' }))
    body.set('expectedVersion', version)
    return body
  }
  const content = 'receipt bytes '.repeat(100)
  const path = '/api/rounds/http-lan/expenses/expense/receipts'
  await assert.rejects(apiRequest(path, { method: 'POST', body: form(content, '1') }))
  const getRandomValues = crypto.getRandomValues.bind(crypto)
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues } })
  assert.equal(crypto.randomUUID, undefined)
  assert.equal(crypto.subtle, undefined)
  await assert.rejects(apiRequest(path, { method: 'POST', body: form(content.replace('r', 'R'), '2') }), error => error instanceof ApiError && error.code === 'unresolved_request')
  assert.equal(requests.length, 1, 'same size and filename do not allow different bytes to replace a pending request')
  await apiRequest(path, { method: 'POST', body: form(content, '2') })
  assert.equal(requests[0].key, requests[1].key, 'native and JS SHA-256 produce the same retry fingerprint')
  assert.equal(requests[1].body?.get('expectedVersion'), '1')
  await apiRequest('/api/http-lan-operation', { method: 'POST', body: {} })
  assert.match(requests[2].key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  await apiRequest(path, { method: 'POST', body: form(content, '3') })
  assert.notEqual(requests[2].key, requests[3].key)
})

test('leaving the bank form discards sensitive retry input, including an already exposed recovery callback', async () => {
  fakeWindow()
  const requests: { key: string | null; body: string }[] = []
  globalThis.fetch = async (_input, init) => {
    requests.push({ key: new Headers(init?.headers).get('Idempotency-Key'), body: String(init?.body) })
    return requests.length === 1 ? Response.json({ error: 'storage_unavailable' }, { status: 503 }) : Response.json({ data: { id: 'member', bankVersion: 1 } })
  }
  const path = '/api/me/bank-account'
  const original = { bankCode: '004', accountNumber: '0012345', accountHolder: '테스트', expectedBankVersion: 0 }
  await assert.rejects(() => apiRequest(path, { method: 'PUT', body: original }))
  let recover: (() => Promise<unknown>) | undefined
  await assert.rejects(() => apiRequest(path, { method: 'PUT', body: { ...original, accountNumber: '0098765' } }), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.code, 'unresolved_request')
    recover = error.recover
    return true
  })
  discardBankAccountRequests()
  assert.ok(recover)
  await assert.rejects(recover, error => error instanceof ApiError && error.code === 'request_discarded')
  assert.equal(requests.length, 1)
  await apiRequest(path, { method: 'PUT', body: { ...original, accountNumber: '0098765' } })
  assert.notEqual(requests[0].key, requests[1].key)
  assert.equal(JSON.parse(requests[1].body).accountNumber, '0098765')
})

test('closing the form before request preparation completes cannot restore discarded account details', async () => {
  fakeWindow()
  let calls = 0
  globalThis.fetch = async () => { calls++; return Response.json({ data: { id: 'member' } }) }
  const controller = new AbortController()
  const request = apiRequest('/api/me/onboarding', { method: 'POST', body: { accountHolder: '테스트' }, signal: controller.signal })
  controller.abort()
  discardBankAccountRequests()
  await assert.rejects(() => request, error => error instanceof DOMException && error.name === 'AbortError')
  assert.equal(calls, 0)
  await apiRequest('/api/me/onboarding', { method: 'POST', body: { accountNumber: '0098765' } })
  assert.equal(calls, 1)
})

test('corrected bank input uses a fresh request key', async () => {
  fakeWindow()
  const requests: { key: string | null; body: string }[] = []
  globalThis.fetch = async (_input, init) => {
    requests.push({ key: new Headers(init?.headers).get('Idempotency-Key'), body: String(init?.body) })
    return requests.length === 1
      ? Response.json({ error: 'invalid_input' }, { status: 400 })
      : Response.json({ data: { id: 'member', bankVersion: 1 } })
  }
  const path = '/api/me/bank-account'
  await assert.rejects(() => apiRequest(path, { method: 'PUT', body: { accountNumber: 'bad' } }), error => error instanceof ApiError && error.code === 'invalid_input')
  await apiRequest(path, { method: 'PUT', body: { accountNumber: '123456' } })
  assert.notEqual(requests[0].key, requests[1].key)
  assert.equal(JSON.parse(requests[1].body).accountNumber, '123456')
})

test('expired bank authentication discards the original personal data before login redirect', async () => {
  const redirects = fakeWindow('/home/all')
  globalThis.fetch = async () => Response.json({ error: 'unauthorized' }, { status: 401 })
  await assert.rejects(() => apiRequest('/api/me/bank-account', { method: 'PUT', body: { accountNumber: '123456' } }))
  assert.equal(redirects.length, 1)
  globalThis.fetch = async () => Response.json({ data: { id: 'member' } })
  assert.deepEqual(await apiRequest('/api/me/bank-account', { method: 'PUT', body: { accountNumber: '0098765' } }), { id: 'member' })
})

function fakeWindow(path = '/settlements/round-a', search = '') {
  const redirects: string[] = []
  const storage = new Map([['da_moa_access', 'test-access-token']])
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location: { pathname: path, search, assign: (path: string) => redirects.push(path) },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
  } })
  return redirects
}

test('failed mutation keeps its request key for retry; the next intentional submission gets a new key', async () => {
  fakeWindow()
  const keys: string[] = []
  globalThis.fetch = async (_input, init) => {
    keys.push(new Headers(init?.headers).get('Idempotency-Key')!)
    if (keys.length === 1) return Response.json({ error: 'transaction_retry', message: '다시 시도' }, { status: 503 })
    return Response.json({ data: { id: 'expense-a' } })
  }
  const request = () => apiRequest('/api/rounds/round-a/expenses', { method: 'POST', body: { amount: '9007199254740993', expectedVersion: 1 } })
  await assert.rejects(request, error => error instanceof ApiError && error.status === 503)
  assert.deepEqual(await request(), { id: 'expense-a' })
  await request()
  assert.equal(keys[0], keys[1])
  assert.notEqual(keys[1], keys[2])
})

test('session refresh retries the unchanged mutation with the same key and body', async () => {
  const redirects = fakeWindow()
  const requests: { path: string; key: string | null; body: BodyInit | null | undefined }[] = []
  globalThis.fetch = async (input, init) => {
    requests.push({ path: String(input), key: new Headers(init?.headers).get('Idempotency-Key'), body: init?.body })
    if (requests.length === 1) return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (String(input) === '/api/auth/refresh') return Response.json({ data: { accessToken: 'refreshed-access-token' } })
    return Response.json({ data: { version: 2 } })
  }
  await apiRequest('/api/rounds/round-a/confirm', { method: 'POST', body: { expectedVersion: 1 } })
  assert.equal(requests[1].path, '/api/auth/refresh')
  assert.equal(requests[0].key, requests[2].key)
  assert.equal(requests[0].body, requests[2].body)
  assert.deepEqual(redirects, [])
})

test('logout clears the local Access token and requests carry Bearer authorization', async () => {
  fakeWindow()
  globalThis.fetch = async (_input, init) => {
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-access-token')
    return Response.json({ ok: true })
  }
  await apiRequest('/api/auth/logout', { method: 'POST' })
  assert.equal(window.localStorage.getItem('da_moa_access'), null)
})

test('an expired session retains the settlement destination while redirecting to login', async () => {
  const redirects = fakeWindow()
  globalThis.fetch = async () => Response.json({ error: 'unauthorized' }, { status: 401 })
  await assert.rejects(() => apiRequest('/api/me'), error => error instanceof ApiError && error.status === 401)
  assert.deepEqual(redirects, ['/login?returnTo=%2Fsettlements%2Fround-a'])
})

test('receipt byte responses use the same authenticated request path', async () => {
  fakeWindow()
  globalThis.fetch = async () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } })
  const blob = await apiRequest<Blob>('/api/receipts/receipt-a', { response: 'blob' })
  assert.equal(blob.type, 'image/png')
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [137, 80, 78, 71])
})

test('expired onboarding preserves its invitation destination without creating an authentication loop', async () => {
  const redirects = fakeWindow('/onboarding', '?returnTo=%2Finvites%2Ftest-token')
  globalThis.fetch = async () => Response.json({ error: 'unauthorized' }, { status: 401 })
  await assert.rejects(() => apiRequest('/api/me'))
  assert.deepEqual(redirects, ['/login?returnTo=%2Finvites%2Ftest-token'])
})

test('a refreshed round version replays the original unacknowledged payload and key', async () => {
  fakeWindow()
  const requests: { key: string | null; body: string }[] = []
  globalThis.fetch = async (_input, init) => {
    requests.push({ key: new Headers(init?.headers).get('Idempotency-Key'), body: String(init?.body) })
    return requests.length === 1 ? Response.json({ error: 'transaction_retry' }, { status: 503 }) : Response.json({ data: { id: 'already-committed-expense', version: 2 } })
  }
  const body = { amount: '10000', expectedVersion: 1 }
  await assert.rejects(() => apiRequest('/api/rounds/replay-version/expenses', { method: 'POST', body }))
  body.expectedVersion = 2
  const result = await apiRequest('/api/rounds/replay-version/expenses', { method: 'POST', body })
  assert.deepEqual(result, { id: 'already-committed-expense', version: 2 })
  assert.equal(requests[0].key, requests[1].key)
  assert.equal(requests[0].body, requests[1].body)
  assert.equal(JSON.parse(requests[1].body).expectedVersion, 1)
})

test('changed input is blocked until the previous write is resolved explicitly', async () => {
  fakeWindow()
  const requests: { key: string | null; body: string }[] = []
  globalThis.fetch = async (_input, init) => {
    requests.push({ key: new Headers(init?.headers).get('Idempotency-Key'), body: String(init?.body) })
    return requests.length === 1 ? Response.json({ error: 'transaction_retry' }, { status: 503 }) : Response.json({ data: { id: 'original-expense' } })
  }
  await assert.rejects(() => apiRequest('/api/rounds/replay-input/expenses', { method: 'POST', body: { amount: '10000', expectedVersion: 1 } }))
  let unresolved: ApiError | undefined
  await assert.rejects(() => apiRequest('/api/rounds/replay-input/expenses', { method: 'POST', body: { amount: '20000', expectedVersion: 2 } }), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.code, 'unresolved_request')
    unresolved = error
    return true
  })
  assert.equal(requests.length, 1)
  assert.ok(unresolved?.recover)
  assert.deepEqual(await unresolved.recover(), { id: 'original-expense' })
  assert.equal(requests[0].key, requests[1].key)
  assert.equal(requests[0].body, requests[1].body)
  await apiRequest('/api/rounds/replay-input/expenses', { method: 'POST', body: { amount: '20000', expectedVersion: 2 } })
  assert.notEqual(requests[1].key, requests[2].key)
})

test('a confirmed version conflict allows a fresh request using the latest version', async () => {
  fakeWindow()
  const requests: { key: string | null; body: string }[] = []
  globalThis.fetch = async (_input, init) => {
    requests.push({ key: new Headers(init?.headers).get('Idempotency-Key'), body: String(init?.body) })
    return requests.length === 1 ? Response.json({ error: 'stale_round' }, { status: 409 }) : Response.json({ data: { id: 'new-expense' } })
  }
  await assert.rejects(() => apiRequest('/api/rounds/version-conflict/expenses', { method: 'POST', body: { amount: '10', expectedVersion: 1 } }))
  await apiRequest('/api/rounds/version-conflict/expenses', { method: 'POST', body: { amount: '10', expectedVersion: 2 } })
  assert.notEqual(requests[0].key, requests[1].key)
  assert.equal(JSON.parse(requests[1].body).expectedVersion, 2)
})

test('receipt retry retains its original version and bytes after a round refresh', async () => {
  fakeWindow()
  const requests: { key: string | null; version: string; size: number }[] = []
  globalThis.fetch = async (_input, init) => {
    const form = init?.body as FormData
    requests.push({ key: new Headers(init?.headers).get('Idempotency-Key'), version: String(form.get('expectedVersion')), size: (form.get('file') as File).size })
    return requests.length === 1 ? Response.json({ error: 'transaction_retry' }, { status: 503 }) : Response.json({ data: { id: 'receipt' } })
  }
  function form(version: string) {
    const result = new FormData()
    result.set('file', new File(['receipt bytes'], 'receipt.png', { type: 'image/png' }))
    result.set('expectedVersion', version)
    return result
  }
  await assert.rejects(() => apiRequest('/api/rounds/receipt-replay/expenses/expense/receipts', { method: 'POST', body: form('1') }))
  await apiRequest('/api/rounds/receipt-replay/expenses/expense/receipts', { method: 'POST', body: form('2') })
  assert.deepEqual(requests[0], requests[1])
})

test('overlapping GETs share a request but completed reads and different tokens stay independent', async () => {
  fakeWindow()
  let calls = 0
  globalThis.fetch = async () => { calls++; return Response.json({ data: { sequence: calls } }) }
  const first = apiRequest('/api/groups')
  const duplicate = apiRequest('/api/groups')
  assert.equal(first, duplicate)
  await Promise.all([first, duplicate, apiRequest('/api/groups?q=other')])
  assert.equal(calls, 2)
  await apiRequest('/api/groups')
  assert.equal(calls, 3)
  await Promise.all([apiRequest('/api/groups'), apiRequest('/api/groups', { fresh: true })])
  assert.equal(calls, 5, 'invalidation must not reuse a read started before a write')
  const oldAccount = apiRequest('/api/me')
  window.localStorage.setItem('da_moa_access', 'other-account-token')
  await Promise.all([oldAccount, apiRequest('/api/me')])
  assert.equal(calls, 7)
})

test('failed GETs are not cached and callers with AbortSignal remain independent', async () => {
  fakeWindow()
  let calls = 0
  globalThis.fetch = async () => { calls++; return Response.json({ error: 'storage_unavailable' }, { status: 503 }) }
  await assert.rejects(apiRequest('/api/groups'))
  await assert.rejects(apiRequest('/api/groups'))
  assert.equal(calls, 2)
  const controller = new AbortController()
  await Promise.allSettled([apiRequest('/api/groups', { signal: controller.signal }), apiRequest('/api/groups')])
  assert.equal(calls, 4)
})

test('me 401 and 404 refresh once then retry once, while domain 404 never refreshes', async () => {
  for (const status of [401, 404]) {
    const redirects = fakeWindow()
    const paths: string[] = []
    globalThis.fetch = async (input, init) => {
      paths.push(String(input))
      if (input === '/api/auth/refresh') return Response.json({ data: { accessToken: 'renewed-token' } })
      if (paths.length === 1) return Response.json({ error: 'not_found' }, { status })
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer renewed-token')
      return Response.json({ data: { id: 'member' } })
    }
    assert.deepEqual(await apiRequest('/api/me'), { id: 'member' })
    assert.deepEqual(paths, ['/api/me', '/api/auth/refresh', '/api/me'])
    assert.deepEqual(redirects, [])
  }
  const paths: string[] = []
  globalThis.fetch = async input => { paths.push(String(input)); return Response.json({ error: 'not_found' }, { status: 404 }) }
  await assert.rejects(apiRequest('/api/groups/missing'), error => error instanceof ApiError && error.status === 404)
  assert.deepEqual(paths, ['/api/groups/missing'])
})

test('me refresh and retry failures stop without an authentication loop', async () => {
  for (const refreshStatus of [200, 401, 503]) {
    const redirects = fakeWindow()
    const paths: string[] = []
    globalThis.fetch = async input => {
      paths.push(String(input))
      if (input === '/api/auth/refresh') return Response.json({ data: { accessToken: 'renewed-token' } }, { status: refreshStatus })
      return Response.json({ error: 'not_found' }, { status: 404 })
    }
    await assert.rejects(apiRequest('/api/me'), error => error instanceof ApiError && error.status === (refreshStatus === 200 ? 404 : refreshStatus))
    assert.deepEqual(paths, refreshStatus === 200 ? ['/api/me', '/api/auth/refresh', '/api/me'] : ['/api/me', '/api/auth/refresh'])
    assert.equal(redirects.length, refreshStatus === 401 ? 1 : 0)
  }
})

test('authentication redirects discard pending bodies and recovery callbacks across domains', async () => {
  for (const status of [401, 403]) {
    fakeWindow()
    let calls = 0
    globalThis.fetch = async input => {
      calls++
      return String(input) === '/api/groups'
        ? Response.json({ error: 'storage_unavailable' }, { status: 503 })
        : Response.json({ error: status === 401 ? 'unauthorized' : 'onboarding_required' }, { status })
    }
    await assert.rejects(() => apiRequest('/api/groups', { method: 'POST', body: { name: '기존 입력' } }))
    let recover: (() => Promise<unknown>) | undefined
    await assert.rejects(() => apiRequest('/api/groups', { method: 'POST', body: { name: '새 입력' } }), error => {
      assert.ok(error instanceof ApiError)
      recover = error.recover
      return error.code === 'unresolved_request'
    })
    await assert.rejects(() => apiRequest('/api/me'))
    const beforeRecovery = calls
    assert.ok(recover)
    await assert.rejects(recover, error => error instanceof ApiError && error.code === 'request_discarded')
    assert.equal(calls, beforeRecovery)
  }
})

test('round creation sends a UUIDv7 ticket and preserves it after a lost response', async () => {
  fakeWindow()
  const keys: string[] = []
  globalThis.fetch = async (_input, init) => {
    keys.push(new Headers(init?.headers).get('Idempotency-Key')!)
    if (keys.length === 1) throw new TypeError('response lost')
    return Response.json({ error: 'round_already_exists' }, { status: 409 })
  }
  const body = { name: '검증 회차', participantIds: ['a', 'b'] }
  await assert.rejects(createRoundRequest('ticket-test', body), error => error instanceof ApiError && error.code === 'network_error')
  await assert.rejects(createRoundRequest('ticket-test', body), error => error instanceof ApiError && error.code === 'round_already_exists')
  assert.match(keys[0], /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(keys[0], keys[1])
  await assert.rejects(createRoundRequest('ticket-test', body))
  assert.notEqual(keys[1], keys[2], 'a definitive 409 clears the pending ticket')
})

test('group creation owns its UUIDv7 policy while generic requests keep random keys', async () => {
  fakeWindow()
  const keys: string[] = []
  globalThis.fetch = async (_input, init) => {
    keys.push(new Headers(init?.headers).get('Idempotency-Key')!)
    return Response.json({ data: { id: 'created' } })
  }
  await createGroupRequest({ name: '모임' })
  await apiRequest('/api/generic-operation', { method: 'POST', body: {} })
  assert.equal(keys[0].split('-')[2][0], '7')
  assert.equal(keys[1].split('-')[2][0], '4')
})
