import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { apiRequest, ApiError } from './api-client'

const originalFetch = globalThis.fetch
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})

function fakeWindow(path = '/settlements/round-a', search = '') {
  const redirects: string[] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { pathname: path, search, assign: (path: string) => redirects.push(path) } } })
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
    if (String(input) === '/api/auth/refresh') return Response.json({ ok: true })
    return Response.json({ data: { version: 2 } })
  }
  await apiRequest('/api/rounds/round-a/confirm', { method: 'POST', body: { expectedVersion: 1 } })
  assert.equal(requests[1].path, '/api/auth/refresh')
  assert.equal(requests[0].key, requests[2].key)
  assert.equal(requests[0].body, requests[2].body)
  assert.deepEqual(redirects, [])
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

test('a confirmed version conflict allows a fresh request using the reviewed latest version', async () => {
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
