import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { isUUID } from 'class-validator'
import { apiRequest, ApiError } from '../../global/util/apiClient.ts'
import { createRoundRequest } from '../../domain/settle/requests.ts'
import { createGroupRequest } from '../../domain/group/requests.ts'
import { discardBankAccountRequests } from '../../domain/user/requests.ts'

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

test('429 이후 응답 유실·수동 재시도에서도 원래 변경 키·본문을 유지한다', async () => {
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

test('제한된 조회는 Retry-After만큼 대기하고 한 번 재시도하며 진행 중 조회를 공유한다', async t => {
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

test('토큰 갱신 제한 시 인증·변경 키를 유지하고 재시도 가능한 429 정보를 전달한다', async () => {
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

test('조회는 429를 한 번만 재시도하고 대기를 취소하면 두 번째 요청을 보내지 않는다', async t => {
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

test('LAN HTTP 환경에서 UUID·암호 API 없이 변경·영수증 재시도를 지원하고 파일 변경을 차단한다', async () => {
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
  assert.ok(isUUID(requests[2].key, '4'))
  await apiRequest(path, { method: 'POST', body: form(content, '3') })
  assert.notEqual(requests[2].key, requests[3].key)
})

test('계좌 입력을 떠날 때 복구 콜백을 포함한 민감한 재시도 데이터를 지운다', async () => {
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

test('요청 준비 전에 폼을 닫아도 지운 계좌 정보를 복구하지 않는다', async () => {
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

test('수정한 계좌 입력에는 새 요청 키를 사용한다', async () => {
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

test('계좌 인증 만료 시 로그인 이동 전에 원래 개인정보를 지운다', async () => {
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

test('변경 실패 시 재시도 키를 유지하고 다음 제출에는 새 키를 사용한다', async () => {
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

test('세션 갱신 후 동일한 변경 키·본문으로 요청을 다시 시도한다', async () => {
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

test('로그아웃 시 로컬 접근 토큰을 지우고 요청에 Bearer 인증을 전달한다', async () => {
  fakeWindow()
  globalThis.fetch = async (_input, init) => {
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-access-token')
    return Response.json({ ok: true })
  }
  await apiRequest('/api/auth/logout', { method: 'POST' })
  assert.equal(window.localStorage.getItem('da_moa_access'), null)
})

test('세션 만료로 로그인 이동 시 정산 목적지를 유지한다', async () => {
  const redirects = fakeWindow()
  globalThis.fetch = async () => Response.json({ error: 'unauthorized' }, { status: 401 })
  await assert.rejects(() => apiRequest('/api/me'), error => error instanceof ApiError && error.status === 401)
  assert.deepEqual(redirects, ['/login?returnTo=%2Fsettlements%2Fround-a'])
})

test('영수증 바이너리 응답에도 동일한 인증 요청 경로를 사용한다', async () => {
  fakeWindow()
  globalThis.fetch = async () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } })
  const blob = await apiRequest<Blob>('/api/receipts/receipt-a', { response: 'blob' })
  assert.equal(blob.type, 'image/png')
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [137, 80, 78, 71])
})

test('온보딩 만료 시 초대 목적지를 유지하고 인증 반복을 만들지 않는다', async () => {
  const redirects = fakeWindow('/onboarding', '?returnTo=%2Finvites%2Ftest-token')
  globalThis.fetch = async () => Response.json({ error: 'unauthorized' }, { status: 401 })
  await assert.rejects(() => apiRequest('/api/me'))
  assert.deepEqual(redirects, ['/login?returnTo=%2Finvites%2Ftest-token'])
})

test('회차 버전 갱신 후 미확인된 원래 본문·키를 재전송한다', async () => {
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

test('이전 쓰기의 결과를 명시적으로 해결할 때까지 입력 변경을 차단한다', async () => {
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

test('확인된 버전 충돌은 최신 버전으로 새 요청을 허용한다', async () => {
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

test('회차 갱신 후 영수증 재시도의 원래 버전·바이트를 유지한다', async () => {
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

test('동시 조회는 요청을 공유하되 완료된 조회와 다른 토큰은 분리한다', async () => {
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

test('실패한 조회는 캐시하지 않고 취소 신호를 가진 요청은 분리한다', async () => {
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

test('내 정보의 401·404는 토큰 갱신 후 한 번 재시도하고 도메인 404는 갱신하지 않는다', async () => {
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

test('내 정보의 갱신·재조회 실패 시 인증 반복 없이 멈춘다', async () => {
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

test('로그인 이동 시 도메인별 대기 본문·복구 콜백을 지운다', async () => {
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

test('회차 생성이 UUIDv7 키를 보내고 응답 유실 후에도 유지한다', async () => {
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
  assert.ok(isUUID(keys[0], '7'))
  assert.equal(keys[0], keys[1])
  await assert.rejects(createRoundRequest('ticket-test', body))
  assert.notEqual(keys[1], keys[2], 'a definitive 409 clears the pending ticket')
})

test('모임 생성이 UUIDv7 정책을 담당하고 일반 요청은 무작위 키를 사용한다', async () => {
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
