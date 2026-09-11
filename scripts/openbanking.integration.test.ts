import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, afterEach, before, test } from 'node:test'
import { currentTimestamp, readAccessToken, type AccessToken } from '../src/lib/auth.ts'
import { signInKakao } from '../src/lib/auth-store.ts'
import { createDatabaseClient, withReadTransaction, withWriteTransaction } from '../src/lib/db.ts'
import { AppError } from '../src/lib/errors.ts'
import { decryptOpenBankingSecret } from '../src/lib/openbanking.ts'
import {
  allocateBankTranId, assertBankVerification, completeOpenBanking, getOpenBankingStatus, getRegisteredBankAccounts, getServiceToken,
  prepareBankVerification, requestDisconnect, retryDisconnect, startOpenBanking,
} from '../src/lib/openbanking-store.ts'
import { applyMigrations } from './migrations.mjs'

const testUrl = process.env.TEST_DATABASE_URL
if (!testUrl || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(testUrl).hostname) || !new URL(testUrl).pathname.toLowerCase().includes('test')) throw new Error('TEST_DATABASE_URL must identify an isolated local test database')
Object.assign(process.env, {
  DATABASE_URL: testUrl,
  AUTH_JWT_SECRET: 'isolated-openbanking-test-secret-at-least-32-bytes',
  OPENBANKING_ENV: 'test', OPENBANKING_CLIENT_ID: 'test-client', OPENBANKING_CLIENT_SECRET: 'test-secret',
  OPENBANKING_CLIENT_USE_CODE: 'T123456789', OPENBANKING_REDIRECT_URI: 'http://localhost:3000/auth/v1/openbanking',
  OPENBANKING_SCOPES: 'login inquiry', OPENBANKING_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  OPENBANKING_REQUEST_HMAC_KEY: Buffer.alloc(32, 2).toString('base64'),
})
const originalFetch = globalThis.fetch
const schema = `openbanking_store_${randomUUID().replaceAll('-', '')}`
afterEach(() => { globalThis.fetch = originalFetch })
before(async () => {
  const client = createDatabaseClient(testUrl)
  try {
    await client.connect()
    await client.query(`CREATE SCHEMA ${schema}`)
    await client.query(`SET search_path TO ${schema}`)
    await applyMigrations(client)
    const isolatedUrl = new URL(testUrl)
    isolatedUrl.searchParams.set('options', `-csearch_path=${schema}`)
    process.env.DATABASE_URL = isolatedUrl.toString()
  } finally { await client.end() }
})
after(async () => {
  const client = createDatabaseClient(testUrl)
  try { await client.connect(); await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`) } finally { await client.end() }
})
const codeIs = (code: string) => (error: unknown) => error instanceof AppError && error.code === code
const profile = { displayName: '계좌 검증', email: null, profileImageUrl: null }
const tokenBody = (token = 'user-access') => ({ access_token: token, refresh_token: 'user-refresh', token_type: 'Bearer',
  expires_in: 3600, scope: 'login inquiry', user_seq_no: 'U123456789' })
const registeredAccounts = () => Response.json({ rsp_code: 'A0000', res_cnt: '1', res_list: [{
  fintech_use_num: '123456789012345678901234', bank_code_std: '004', account_holder_name: '홍길동',
  account_num_masked: '001-2345-***', account_state: '01', inquiry_agree_yn: 'Y', account_holder_type: 'P',
}] })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(finish => { resolve = finish })
  return { promise, resolve }
}
async function member() {
  const subject = `openbanking-test-${randomUUID()}`
  const session = await signInKakao(subject, profile)
  const access = readAccessToken(session.accessToken)
  assert.ok(access)
  return { subject, session, access }
}
async function begin(access: AccessToken) {
  const started = await startOpenBanking(access, 'onboarding', '/invites/example')
  assert.ok(started.authorizationUrl)
  return new URL(started.authorizationUrl).searchParams.get('state')!
}
async function connected(accessToken = 'user-access') {
  const user = await member()
  const state = await begin(user.access)
  globalThis.fetch = async () => Response.json(tokenBody(accessToken))
  assert.equal((await completeOpenBanking(user.access, state, { code: 'test-code' })).error, undefined)
  return user
}
async function leave(access: AccessToken) {
  return withWriteTransaction(async client => {
    await client.query('UPDATE users SET deleted_at=$2 WHERE id=$1', [access.userId, currentTimestamp()])
    await client.query('UPDATE refresh_sessions SET revoked_at=$2 WHERE user_id=$1', [access.userId, currentTimestamp()])
    return requestDisconnect(client, access.userId)
  })
}
async function connection(userId: string) {
  return withReadTransaction(async client => (await client.query('SELECT * FROM openbanking_connections WHERE user_id=$1', [userId])).rows[0])
}

test('OAuth state binds member and original session, superseded state and replay cannot exchange codes', async () => {
  const a = await member(), b = await member()
  let exchanges = 0
  globalThis.fetch = async () => { exchanges++; return Response.json(tokenBody()) }
  const first = await begin(a.access)
  assert.match(first, /^[A-Za-z0-9_-]{32}$/)
  await assert.rejects(completeOpenBanking(b.access, first, { code: 'other' }), codeIs('invalid_input'))
  const second = await begin(a.access)
  await assert.rejects(completeOpenBanking(a.access, first, { code: 'stale' }), codeIs('invalid_input'))
  assert.deepEqual(await completeOpenBanking(a.access, second, { code: 'valid' }), { returnTo: '/onboarding?returnTo=%2Finvites%2Fexample&verify=1' })
  await assert.rejects(completeOpenBanking(a.access, second, { code: 'replay' }), codeIs('invalid_input'))
  assert.equal(exchanges, 1)
  const row = await connection(a.access.userId)
  assert.notEqual(row.access_token, 'user-access')
  assert.equal(decryptOpenBankingSecret(row.access_token, `user:${a.access.userId}:${row.connection_id}:access`), 'user-access')
  const reused = await startOpenBanking(a.access, 'onboarding', '/settlements/example')
  assert.deepEqual(reused, { returnTo: '/onboarding?returnTo=%2Fsettlements%2Fexample&verify=1' })
  assert.equal(exchanges, 1, 'a valid connection is reused without another OAuth exchange')
})

test('verification captures reject stale bank versions and revoked sessions, quotas persist without input data', async () => {
  const user = await connected()
  const capture = await prepareBankVerification(user.access, 0, true)
  await withWriteTransaction(async client => {
    assert.equal((await assertBankVerification(client, user.access, capture, 0, true)).id, user.access.userId)
    await client.query('UPDATE users SET bank_version=bank_version+1 WHERE id=$1', [user.access.userId])
  })
  await assert.rejects(withWriteTransaction(client => assertBankVerification(client, user.access, capture, 0, true)), codeIs('bank_account_conflict'))
  for (let i = 1; i < 10; i++) await prepareBankVerification(user.access, 1, true)
  await assert.rejects(prepareBankVerification(user.access, 1, true), codeIs('bank_verification_rate_limited'))
  assert.equal((await connection(user.access.userId)).verification_count, 10)
  await leave(user.access)
  await assert.rejects(withWriteTransaction(client => assertBankVerification(client, user.access, capture, 0, true)), codeIs('unauthorized'))
})

test('first OAuth response arriving after withdrawal is only cleaned up, and pending cleanup blocks new grants', async () => {
  const user = await member()
  const state = await begin(user.access)
  const entered = deferred<void>(), token = deferred<Response>()
  let closes = 0
  globalThis.fetch = async url => {
    if (String(url).endsWith('/token')) { entered.resolve(); return token.promise }
    assert.ok(String(url).endsWith('/user/close'))
    closes++
    return Response.json({ rsp_code: 'A0000' })
  }
  const callback = completeOpenBanking(user.access, state, { code: 'late' })
  await entered.promise
  assert.equal(await leave(user.access), 'pending')
  assert.equal((await retryDisconnect(user.access.userId)).pending, 1)
  assert.equal(closes, 0, 'the unfinished grant must settle before unlink')
  const rejoin = await signInKakao(user.subject, profile)
  const rejoinAccess = readAccessToken(rejoin.accessToken)!
  await assert.rejects(startOpenBanking(rejoinAccess, 'onboarding'), codeIs('openbanking_disconnect_pending'))
  token.resolve(Response.json(tokenBody('late-access')))
  assert.equal((await callback).error, 'openbanking_unavailable')
  assert.equal((await connection(user.access.userId)).status, 'DISCONNECT_PENDING')
  assert.deepEqual(await retryDisconnect(user.access.userId), { completed: 1, pending: 0, skipped: 0, needsOperator: 0 })
  assert.equal(closes, 1)
  assert.equal((await connection(user.access.userId)).status, 'DISCONNECTED')
  assert.ok((await startOpenBanking(rejoinAccess, 'onboarding')).authorizationUrl)
})

test('withdrawal during the provider authorization screen accepts a late callback only for cleanup', async () => {
  const user = await member(), state = await begin(user.access)
  assert.equal(await leave(user.access), 'pending')
  let exchanges = 0, closes = 0
  globalThis.fetch = async url => {
    if (String(url).endsWith('/token')) { exchanges++; return Response.json(tokenBody()) }
    closes++
    return Response.json({ rsp_code: 'A0000' })
  }
  assert.equal((await retryDisconnect(user.access.userId)).pending, 1)
  assert.equal(closes, 0)
  assert.equal((await completeOpenBanking(null, state, { code: 'authorization-completed-after-withdrawal' })).error, 'openbanking_unavailable')
  assert.equal(exchanges, 1)
  assert.equal((await connection(user.access.userId)).status, 'DISCONNECT_PENDING')
  assert.equal((await retryDisconnect(user.access.userId)).completed, 1)
  assert.equal(closes, 1)
})

test('completed OAuth after logout is recovered by the same member without another external grant', async () => {
  const user = await member(), state = await begin(user.access)
  const entered = deferred<void>(), token = deferred<Response>()
  let requests = 0
  globalThis.fetch = async () => { requests++; entered.resolve(); return token.promise }
  const callback = completeOpenBanking(user.access, state, { code: 'session-expires' })
  await entered.promise
  await withWriteTransaction(client => client.query('UPDATE refresh_sessions SET revoked_at=$2 WHERE id=$1', [user.access.sessionId, currentTimestamp()]))
  token.resolve(Response.json(tokenBody()))
  assert.equal((await callback).error, 'openbanking_unavailable')
  const nextSession = await signInKakao(user.subject, profile)
  const recovered = await startOpenBanking(readAccessToken(nextSession.accessToken)!, 'onboarding', '/home')
  assert.equal(recovered.returnTo, '/onboarding?returnTo=%2Fhome&verify=1')
  assert.equal(requests, 1)
  assert.equal((await connection(user.access.userId)).status, 'CONNECTED')
})

test('refresh finishing after withdrawal preserves new tokens for cleanup and never reactivates the grant', async () => {
  const user = await connected()
  await withWriteTransaction(client => client.query('UPDATE openbanking_connections SET expires_at=$2 WHERE user_id=$1', [user.access.userId, currentTimestamp() - 1]))
  const entered = deferred<void>(), token = deferred<Response>()
  let closeToken: string | null = null
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/token')) { entered.resolve(); return token.promise }
    closeToken = new Headers(init?.headers).get('Authorization')
    return Response.json({ rsp_code: 'A0000' })
  }
  const refresh = prepareBankVerification(user.access, 0, true)
  await entered.promise
  await leave(user.access)
  token.resolve(Response.json(tokenBody('new-access')))
  await assert.rejects(refresh, codeIs('openbanking_disconnect_pending'))
  assert.equal((await connection(user.access.userId)).status, 'DISCONNECT_PENDING')
  assert.equal((await retryDisconnect(user.access.userId)).completed, 1)
  assert.equal(closeToken, 'Bearer new-access')
  assert.equal((await connection(user.access.userId)).access_token, null)
})

test('one confirmed user close clears older and late grants for the same provider member', async () => {
  const user = await connected()
  await withWriteTransaction(client => client.query("UPDATE openbanking_connections SET status='REAUTH_REQUIRED' WHERE user_id=$1", [user.access.userId]))
  const state = await begin(user.access), entered = deferred<void>(), token = deferred<Response>()
  let closes = 0
  globalThis.fetch = async url => {
    if (String(url).endsWith('/token')) { entered.resolve(); return token.promise }
    closes++
    return Response.json({ rsp_code: closes === 1 ? 'A0000' : 'O0002' })
  }
  const callback = completeOpenBanking(user.access, state, { code: 'reauth-before-withdrawal' })
  await entered.promise
  await leave(user.access)
  token.resolve(Response.json(tokenBody('newest-access')))
  await callback
  assert.equal((await retryDisconnect(user.access.userId)).completed, 1)
  assert.equal(closes, 1, 'the first close already invalidates the older token for this same member')
  assert.equal((await connection(user.access.userId)).access_token, null)
})

test('unknown unlink outcome is durable and cannot be resent after lease expiry or during rejoin', async () => {
  const user = await connected('unknown-unlink-access')
  await leave(user.access)
  let requests = 0
  globalThis.fetch = async (_url, init) => {
    if (new Headers(init?.headers).get('Authorization') === 'Bearer unknown-unlink-access') {
      requests++
      throw new Error('simulated response loss')
    }
    return Response.json({ rsp_code: 'A0000' })
  }
  assert.equal((await retryDisconnect(user.access.userId)).pending, 1)
  await withWriteTransaction(client => client.query('UPDATE openbanking_connections SET operation_lease_until=0,disconnect_next_attempt_at=0 WHERE user_id=$1', [user.access.userId]))
  assert.equal((await retryDisconnect(user.access.userId, { retryRejected: true })).pending, 1)
  assert.equal(requests, 1)
  assert.equal((await connection(user.access.userId)).operation_outcome, 'unknown')
  await withWriteTransaction(client => client.query('UPDATE openbanking_connections SET disconnect_next_attempt_at=NULL WHERE user_id=$1', [user.access.userId]))
  assert.ok((await retryDisconnect()).needsOperator >= 1, 'the scheduler reports unknown outcomes even when they are not eligible for retry')
  assert.equal(requests, 1)
  const rejoin = await signInKakao(user.subject, profile)
  await assert.rejects(startOpenBanking(readAccessToken(rejoin.accessToken)!, 'onboarding'), codeIs('openbanking_disconnect_pending'))
})

test('expired cleanup access token is refreshed and confirmed transient close rejection is retried', async () => {
  const user = await connected()
  await leave(user.access)
  await withWriteTransaction(client => client.query('UPDATE openbanking_connections SET expires_at=0 WHERE user_id=$1', [user.access.userId]))
  let refreshes = 0, closes = 0
  globalThis.fetch = async url => {
    if (String(url).endsWith('/token')) { refreshes++; return Response.json(tokenBody('cleanup-refreshed')) }
    closes++
    return Response.json({ rsp_code: closes === 1 ? 'A0016' : closes === 2 ? 'A0012' : 'A0014' })
  }
  const delayed = await retryDisconnect(user.access.userId)
  assert.equal(delayed.pending, 1)
  assert.equal(delayed.needsOperator, 0, 'a future retry for a confirmed transient rejection needs no operator')
  assert.equal(refreshes, 1)
  assert.equal(closes, 1)
  assert.ok(Number((await connection(user.access.userId)).disconnect_next_attempt_at) > currentTimestamp())
  await withWriteTransaction(client => client.query('UPDATE openbanking_connections SET disconnect_next_attempt_at=0 WHERE user_id=$1', [user.access.userId]))
  assert.equal((await retryDisconnect(user.access.userId)).pending, 1)
  assert.equal((await connection(user.access.userId)).disconnect_next_attempt_at, null)
  assert.equal((await retryDisconnect(user.access.userId, { retryRejected: true })).completed, 1)
  assert.equal(closes, 3)
})

test('institution token issuance is serialized and transaction IDs stay unique across concurrent calls', async () => {
  await withWriteTransaction(client => client.query("DELETE FROM openbanking_service_tokens WHERE environment='test'"))
  const entered = deferred<void>(), token = deferred<Response>()
  let calls = 0
  globalThis.fetch = async () => { calls++; entered.resolve(); return token.promise }
  const first = getServiceToken()
  await entered.promise
  await assert.rejects(getServiceToken(), codeIs('openbanking_unavailable'))
  token.resolve(Response.json({ access_token: 'institution-token', token_type: 'Bearer', expires_in: 3600, scope: 'oob', client_use_code: 'T123456789' }))
  assert.equal(await first, 'institution-token')
  assert.equal(await getServiceToken(), 'institution-token')
  assert.equal(calls, 1)
  const identifiers = await Promise.all(Array.from({ length: 8 }, () => allocateBankTranId()))
  assert.equal(new Set(identifiers).size, identifiers.length)
  assert.ok(identifiers.every(value => /^T123456789U[A-Z0-9]{9}$/.test(value)))
  const user = await member()
  const status = await withReadTransaction(client => getOpenBankingStatus(client, user.access.userId))
  assert.deepEqual(status, { status: 'NOT_CONNECTED', authenticatedAt: null, environment: 'test' })
})

test('institution issuance recovers expired unknown or crashed leases and rejects the former owner response', async () => {
  const clear = () => withWriteTransaction(client => client.query("DELETE FROM openbanking_service_tokens WHERE environment='test'"))
  const expireLease = () => withWriteTransaction(client => client.query("UPDATE openbanking_service_tokens SET lease_until=0 WHERE environment='test'"))
  const response = (token: string) => Response.json({ access_token: token, token_type: 'Bearer', expires_in: 3600, scope: 'oob', client_use_code: 'T123456789' })
  await clear()
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    if (calls === 1) throw new Error('response lost')
    return response('recovered-service-token')
  }
  await assert.rejects(getServiceToken(), codeIs('openbanking_unavailable'))
  await assert.rejects(getServiceToken(), codeIs('openbanking_unavailable'))
  assert.equal(calls, 1, 'an unknown outcome still observes the original lease before recovery')
  await expireLease()
  assert.equal(await getServiceToken(), 'recovered-service-token')
  assert.equal(calls, 2)

  await clear()
  const entered = deferred<void>(), late = deferred<Response>()
  calls = 0
  globalThis.fetch = async () => {
    if (++calls === 1) { entered.resolve(); return late.promise }
    return response('new-owner-token')
  }
  const formerOwner = getServiceToken()
  await entered.promise
  await expireLease()
  assert.equal(await getServiceToken(), 'new-owner-token')
  const rejectedFormerOwner = assert.rejects(formerOwner, codeIs('openbanking_unavailable'))
  late.resolve(response('late-former-owner-token'))
  await rejectedFormerOwner
  assert.equal(await getServiceToken(), 'new-owner-token')
  assert.equal(calls, 2)
})

test('registered accounts reuse the user grant for onboarding and settings without changing the representative account', async () => {
  const unconnected = await member()
  await assert.rejects(getRegisteredBankAccounts(unconnected.access), codeIs('openbanking_required'))
  const user = await connected('list-access')
  const originalConnection = await connection(user.access.userId)
  let requests = 0
  globalThis.fetch = async (url, init) => {
    const endpoint = new URL(String(url))
    assert.equal(endpoint.pathname, '/v2.0/account/list')
    assert.equal(endpoint.searchParams.get('user_seq_no'), 'U123456789')
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer list-access')
    requests++
    return registeredAccounts()
  }
  const accounts = await getRegisteredBankAccounts(user.access)
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0].accountHolder, '홍길동')
  assert.equal(accounts[0].accountNumber, null, 'a masked response is never invented into a full account number')
  assert.equal(accounts[0].accountNumberMasked, '001-2345-***')
  await withWriteTransaction(async client => {
    await client.query(`UPDATE users SET bank_name='기존 은행',account_number='005678',account_holder='기존 예금주',
      bank_updated_at=$2,onboarding_completed_at=$2 WHERE id=$1`, [user.access.userId, currentTimestamp()])
    await client.query("UPDATE refresh_sessions SET purpose='app' WHERE id=$1", [user.access.sessionId])
  })
  assert.deepEqual(await getRegisteredBankAccounts(user.access), accounts)
  const saved = await withReadTransaction(async client => (await client.query('SELECT account_number,bank_version FROM users WHERE id=$1', [user.access.userId])).rows[0])
  assert.deepEqual(saved, { account_number: '005678', bank_version: 0 })
  assert.deepEqual(await connection(user.access.userId), originalConnection)
  assert.equal(requests, 2, 'listing accounts sends no OAuth, institution-token or unlink request')
})

test('registered account listing marks rejected user grants and refuses results after logout or withdrawal', async () => {
  const invalid = await connected('rejected-list-access')
  const version = (await connection(invalid.access.userId)).version
  globalThis.fetch = async () => Response.json({ rsp_code: 'O0002' })
  await assert.rejects(getRegisteredBankAccounts(invalid.access), codeIs('openbanking_reauth_required'))
  const rejected = await connection(invalid.access.userId)
  assert.equal(rejected.status, 'REAUTH_REQUIRED')
  assert.equal(rejected.version, version + 1)

  for (const action of ['logout', 'withdraw'] as const) {
    const user = await connected(`delayed-list-${action}`)
    const entered = deferred<void>(), response = deferred<Response>()
    globalThis.fetch = async () => { entered.resolve(); return response.promise }
    const listing = getRegisteredBankAccounts(user.access)
    await entered.promise
    if (action === 'withdraw') await leave(user.access)
    else await withWriteTransaction(client => client.query('UPDATE refresh_sessions SET revoked_at=$2 WHERE id=$1', [user.access.sessionId, currentTimestamp()]))
    const denied = assert.rejects(listing, codeIs('unauthorized'))
    response.resolve(registeredAccounts())
    await denied
  }
})
