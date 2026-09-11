import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { ACCESS_TOKEN_COOKIE_NAME, createAccessToken, currentTimestamp, readAccessToken } from '../src/lib/auth.ts'
import { completeOnboarding, signInKakao, updateBankAccount, withdrawAccount } from '../src/lib/auth-store.ts'
import { getAccount } from '../src/lib/authorization.ts'
import { createDatabaseClient } from '../src/lib/db.ts'
import { AppError } from '../src/lib/errors.ts'
import { applyMigrations } from './migrations.mjs'
import { installOpenBankingFixture } from './openbanking-test-support.ts'
import { OPENBANKING_CALLBACK_COOKIE } from '../src/lib/openbanking-callback.ts'
import { retryDisconnect } from '../src/lib/openbanking-store.ts'
import { POST as startOAuth } from '../src/app/api/me/openbanking/route.ts'
import { GET as callbackOAuth } from '../src/app/auth/v1/openbanking/route.ts'

const testUrl = process.env.TEST_DATABASE_URL
if (!testUrl || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(testUrl).hostname) || !new URL(testUrl).pathname.toLowerCase().includes('test')) throw new Error('TEST_DATABASE_URL must name an isolated local test database')
process.env.DATABASE_URL = testUrl
process.env.AUTH_JWT_SECRET = 'isolated-bank-verification-test-secret-at-least-32-bytes'
const codeIs = (code: string) => (error: unknown) => error instanceof AppError && error.code === code
const profile = { displayName: '계좌 확인 회원', email: null, profileImageUrl: null }

test('verified bank saves preserve consent, privacy and atomicity across retries and account races', async t => {
  const client = createDatabaseClient(testUrl)
  await client.connect()
  const fixture = installOpenBankingFixture()
  const schema = `bank_verification_${randomUUID().replaceAll('-', '')}`
  let number = 0
  const bank = (version = 0) => fixture.bank('계좌 확인 회원', `000${++number}`.padEnd(12, '0'), version)
  const basicBank = (version = 0) => {
    const { birthDate: omitted, ...values } = bank(version)
    return { ...values, verifyWithOpenBanking: false }
  }
  const snapshot = async (id: string) => (await client.query(`SELECT bank_name,bank_code,account_number,account_holder,bank_updated_at,
    bank_verified_at,bank_verification_tran_id,bank_version,onboarding_completed_at,deleted_at FROM users WHERE id=$1`, [id])).rows[0]
  const consent = async (id: string) => (await client.query(`SELECT connection_id,status,user_seq_no,access_token,refresh_token,
    expires_at,scope,authenticated_at FROM openbanking_connections WHERE user_id=$1`, [id])).rows[0]
  const inquiryCount = () => fixture.calls.filter(call => call.path === '/v2.0/inquiry/real_name').length
  async function newcomer() {
    const subject = `bank-verification:${randomUUID()}`
    const session = await signInKakao(subject, profile)
    return { subject, session, access: readAccessToken(session.accessToken)! }
  }
  async function member() {
    const person = await newcomer()
    await fixture.authorize(person.access)
    const session = await completeOnboarding(person.access, bank())
    return { ...person, access: readAccessToken(session.accessToken)! }
  }
  function holdInquiry(accountNumber: string) {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    globalThis.fetch = async (url, options) => {
      const response = await fixture.provider(url, options)
      if (new URL(String(url)).pathname === '/v2.0/inquiry/real_name' && JSON.parse(String(options?.body)).account_num === accountNumber) {
        started.resolve()
        await release.promise
      }
      return response
    }
    return { started: started.promise, release: () => { release.resolve(); globalThis.fetch = fixture.provider } }
  }
  try {
    await client.query(`CREATE SCHEMA ${schema}`)
    await client.query(`SET search_path TO ${schema}`)
    const database = new URL(testUrl)
    database.searchParams.set('options', `-csearch_path=${schema}`)
    process.env.DATABASE_URL = database.toString()
    await applyMigrations(client)

    await t.test('verified saves still require OAuth for onboarding or a legacy app member', async () => {
      const person = await newcomer(), input = bank()
      const before = await snapshot(person.access.userId), calls = fixture.calls.length
      await assert.rejects(completeOnboarding(person.access, input), codeIs('openbanking_required'))
      assert.deepEqual(await snapshot(person.access.userId), before)
      assert.equal(fixture.calls.length, calls)
      const now = currentTimestamp()
      await client.query(`UPDATE users SET bank_name='기존 은행',account_number='000999',account_holder='기존 회원',
        bank_updated_at=$2,onboarding_completed_at=$2 WHERE id=$1`, [person.access.userId, now])
      const legacy = readAccessToken((await signInKakao(person.subject, profile)).accessToken)!
      const legacyBefore = await snapshot(legacy.userId)
      assert.equal(legacyBefore.bank_verified_at, null)
      await assert.rejects(updateBankAccount(legacy, randomUUID(), input), codeIs('openbanking_required'))
      assert.deepEqual(await snapshot(legacy.userId), legacyBefore)
      assert.equal(fixture.calls.length, calls)
    })

    await t.test('basic onboarding and saves need no provider credentials and retain session, version and replay checks', async () => {
      const credentials = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('OPENBANKING_')))
      const person = await newcomer(), calls = fixture.calls.length
      for (const name of Object.keys(credentials)) delete process.env[name]
      try {
        await assert.rejects(completeOnboarding(null, basicBank()), codeIs('unauthorized'))
        const session = await completeOnboarding(person.access, basicBank())
        const access = readAccessToken(session.accessToken)!
        const account = await getAccount(access)
        assert.equal(account.bankVerifiedAt, null)
        assert.equal(account.bankVersion, 1)
        assert.equal(account.purpose, 'app')
        assert.equal(await consent(access.userId), undefined)
        const input = basicBank(1), key = randomUUID()
        const saved = await updateBankAccount(access, key, input)
        assert.deepEqual(saved, { id: access.userId, bankVersion: 2 })
        assert.deepEqual(await updateBankAccount(access, key, input), saved)
        await assert.rejects(updateBankAccount(access, key, { ...input, accountNumber: '009999' }), codeIs('idempotency_conflict'))
        await assert.rejects(updateBankAccount(access, 'bad-key', basicBank(2)), codeIs('invalid_request_key'))
        await assert.rejects(updateBankAccount(access, randomUUID(), basicBank(1)), codeIs('bank_account_conflict'))
        const snapshotBeforeFailure = await snapshot(access.userId)
        const failedKey = randomUUID(), constraint = `basic_save_${randomUUID().replaceAll('-', '')}`
        await client.query(`ALTER TABLE mutation_requests ADD CONSTRAINT ${constraint} CHECK (request_key <> '${failedKey}')`)
        try {
          await assert.rejects(updateBankAccount(access, failedKey, basicBank(2)), error => (error as { code?: string }).code === '23514')
          assert.deepEqual(await snapshot(access.userId), snapshotBeforeFailure)
        } finally { await client.query(`ALTER TABLE mutation_requests DROP CONSTRAINT ${constraint}`) }
        await client.query('UPDATE refresh_sessions SET revoked_at=$2 WHERE id=$1', [access.sessionId, currentTimestamp()])
        await assert.rejects(updateBankAccount(access, randomUUID(), basicBank(2)), codeIs('unauthorized'))
        assert.equal(fixture.calls.length, calls, 'basic registration and editing never invoke a provider API')
      } finally { Object.assign(process.env, credentials) }
    })

    await t.test('later verification marks a basic account, same-account saves preserve proof and actual changes remove it', async () => {
      const person = await newcomer(), initial = basicBank()
      const access = readAccessToken((await completeOnboarding(person.access, initial)).accessToken)!
      await fixture.authorize(access)
      const verify = { ...initial, birthDate: '1990-01-01', expectedBankVersion: 1, verifyWithOpenBanking: true }
      await updateBankAccount(access, randomUUID(), verify)
      const verified = await snapshot(access.userId), connection = await consent(access.userId)
      assert.ok(verified.bank_verified_at && verified.bank_verification_tran_id)
      const calls = fixture.calls.length, key = randomUUID()
      const same = { ...initial, expectedBankVersion: 2 }
      await updateBankAccount(access, key, same)
      assert.equal((await snapshot(access.userId)).bank_verified_at, verified.bank_verified_at)
      assert.equal((await snapshot(access.userId)).bank_verification_tran_id, verified.bank_verification_tran_id)
      await assert.rejects(updateBankAccount(access, key, { ...verify, expectedBankVersion: 2 }), codeIs('idempotency_conflict'))
      await updateBankAccount(access, randomUUID(), basicBank(3))
      const replaced = await snapshot(access.userId)
      assert.equal(replaced.bank_verified_at, null)
      assert.equal(replaced.bank_verification_tran_id, null)
      assert.deepEqual(await consent(access.userId), connection)
      assert.equal(fixture.calls.length, calls, 'saving without verification never changes the existing provider link')

      const slowInput = bank(4), fastInput = basicBank(4), gate = holdInquiry(slowInput.accountNumber)
      const slow = updateBankAccount(access, randomUUID(), slowInput)
      const rejected = assert.rejects(slow, codeIs('bank_account_conflict'))
      try {
        await gate.started
        await updateBankAccount(access, randomUUID(), fastInput)
        gate.release()
        await rejected
        assert.equal((await snapshot(access.userId)).account_number, fastInput.accountNumber)
        assert.equal((await snapshot(access.userId)).bank_verified_at, null)
      } finally { gate.release(); await rejected }
    })

    await t.test('basic rejoin requires consent and completed unlink, and never restores the previous verification', async () => {
      const person = await member(), previous = await snapshot(person.access.userId)
      assert.ok(previous.bank_verified_at)
      assert.equal((await withdrawAccount(person.access)).openBankingDisconnect, 'pending')
      const access = readAccessToken((await signInKakao(person.subject, profile)).accessToken)!
      const input = { bankCode: previous.bank_code, accountNumber: previous.account_number, accountHolder: previous.account_holder,
        expectedBankVersion: previous.bank_version, verifyWithOpenBanking: false }
      await assert.rejects(completeOnboarding(access, input), codeIs('rejoin_confirmation_required'))
      await assert.rejects(completeOnboarding(access, { ...input, confirmRejoin: true }), codeIs('openbanking_disconnect_pending'))
      assert.equal((await retryDisconnect(access.userId)).completed, 1)
      const calls = fixture.calls.length
      const session = await completeOnboarding(access, { ...input, confirmRejoin: true })
      const restored = await getAccount(readAccessToken(session.accessToken)!)
      assert.equal(restored.accountNumber, previous.account_number)
      assert.equal(restored.bankVerifiedAt, null)
      assert.equal((await snapshot(access.userId)).bank_verification_tran_id, null)
      assert.equal((await consent(access.userId)).status, 'DISCONNECTED')
      assert.equal(fixture.calls.length, calls)
    })

    await t.test('onboarding commits verification and session together; lost cookies recover through Kakao without another inquiry', async () => {
      const person = await newcomer()
      await fixture.authorize(person.access)
      const input = { ...bank(), accountNumber: '00-123 456' }
      fixture.bank(input.accountHolder, input.accountNumber)
      const session = await completeOnboarding(person.access, input)
      const account = await getAccount(readAccessToken(session.accessToken)!)
      assert.equal(account.accountNumber, '00123456')
      assert.equal(account.bankCode, '004')
      assert.equal(account.bankVersion, 1)
      assert.ok(account.bankVerifiedAt && account.onboardingCompletedAt)
      const inquiries = inquiryCount()
      await assert.rejects(getAccount(person.access, true), codeIs('unauthorized'))
      await assert.rejects(completeOnboarding(person.access, input), codeIs('unauthorized'))
      const recovered = await signInKakao(person.subject, profile)
      assert.equal(recovered.userId, session.userId)
      assert.equal(recovered.purpose, 'app')
      assert.equal((await getAccount(readAccessToken(recovered.accessToken)!)).bankVersion, 1)
      assert.equal(inquiryCount(), inquiries)
    })

    await t.test('callback proof recovers expired app access without rotating sessions or bypassing revocation and current identity', async () => {
      const origin = 'http://localhost:3087'
      async function start() {
        const person = await member()
        await client.query("UPDATE openbanking_connections SET status='REAUTH_REQUIRED' WHERE user_id=$1", [person.access.userId])
        const response = await startOAuth(new NextRequest(`${origin}/api/me/openbanking`, { method: 'POST', headers: {
          origin, 'Content-Type': 'application/json', cookie: `${ACCESS_TOKEN_COOKIE_NAME}=${createAccessToken(person.access.userId, person.access.sessionId)}`,
        }, body: JSON.stringify({ context: 'settings', returnTo: '/home/all' }) }))
        assert.equal(response.status, 200)
        const state = new URL((await response.json()).data.authorizationUrl).searchParams.get('state')!
        const cookie = response.headers.getSetCookie().find(value => value.startsWith(`${OPENBANKING_CALLBACK_COOKIE}=`))!.split(';')[0].slice(OPENBANKING_CALLBACK_COOKIE.length + 1)
        assert.ok(cookie)
        assert.match(response.headers.get('set-cookie')!, /Path=\/auth\/v1\/openbanking/)
        return { person, state, cookie }
      }
      async function callback(started: Awaited<ReturnType<typeof start>>, token?: string) {
        const subject = (await consent(started.person.access.userId)).user_seq_no
        globalThis.fetch = async (url, options) => {
          const response = await fixture.provider(url, options)
          return new URL(String(url)).pathname === '/oauth/2.0/token' ? Response.json({ ...await response.json(), user_seq_no: subject }) : response
        }
        try {
          return await callbackOAuth(new NextRequest(`${origin}/auth/v1/openbanking?state=${started.state}&code=${randomUUID()}`, { headers: {
            cookie: `${OPENBANKING_CALLBACK_COOKIE}=${started.cookie}${token ? `; ${ACCESS_TOKEN_COOKIE_NAME}=${token}` : ''}`,
          } }))
        } finally { globalThis.fetch = fixture.provider }
      }
      const expired = await start()
      const oldToken = createAccessToken(expired.person.access.userId, expired.person.access.sessionId, undefined, currentTimestamp() - 360)
      assert.equal(readAccessToken(oldToken), null)
      const completed = await callback(expired, oldToken)
      assert.equal(completed.status, 303)
      assert.equal(completed.headers.get('location'), `${origin}/home/all?account=1&verify=1`)
      assert.equal((await consent(expired.person.access.userId)).status, 'CONNECTED')
      assert.equal((await getAccount(expired.person.access)).purpose, 'app', 'the original session remains valid')
      assert.deepEqual(completed.cookies.getAll().map(cookie => cookie.name), [OPENBANKING_CALLBACK_COOKIE], 'the callback must not issue application cookies')
      assert.equal(completed.cookies.get(OPENBANKING_CALLBACK_COOKIE)?.value, '')

      const revoked = await start()
      await client.query('UPDATE refresh_sessions SET revoked_at=$2 WHERE id=$1', [revoked.person.access.sessionId, currentTimestamp()])
      const revokedCalls = fixture.calls.length
      const denied = await callback(revoked)
      assert.equal(new URL(denied.headers.get('location')!).searchParams.get('openbanking_error'), 'unauthorized')
      assert.equal(fixture.calls.length, revokedCalls)
      assert.equal((await consent(revoked.person.access.userId)).status, 'REAUTH_REQUIRED')

      const different = await start(), other = await member()
      const differentCalls = fixture.calls.length
      const mismatch = await callback(different, createAccessToken(other.access.userId, other.access.sessionId))
      assert.equal(new URL(mismatch.headers.get('location')!).searchParams.get('openbanking_error'), 'invalid_input')
      assert.equal(fixture.calls.length, differentCalls)
      assert.equal((await consent(different.person.access.userId)).status, 'REAUTH_REQUIRED')
    })

    await t.test('replacement and successful replay retain the connection and store only a secret-keyed digest and result metadata', async () => {
      const person = await member(), input = bank(1), key = randomUUID()
      const priorConsent = await consent(person.access.userId), calls = fixture.calls.length
      const result = await updateBankAccount(person.access, key, input)
      assert.deepEqual(result, { id: person.access.userId, bankVersion: 2 })
      assert.equal(fixture.calls.length, calls + 1)
      assert.deepEqual(await consent(person.access.userId), priorConsent)
      assert.deepEqual(await updateBankAccount(person.access, key, input), result)
      await assert.rejects(updateBankAccount(person.access, key, { ...input, birthDate: '1991-01-01' }), codeIs('idempotency_conflict'))
      assert.equal(fixture.calls.length, calls + 1, 'replay and conflicting keys must not query the provider')
      const originalKey = process.env.OPENBANKING_REQUEST_HMAC_KEY
      try {
        process.env.OPENBANKING_REQUEST_HMAC_KEY = Buffer.alloc(32, 33).toString('base64')
        await assert.rejects(updateBankAccount(person.access, key, input), codeIs('idempotency_conflict'))
      } finally { process.env.OPENBANKING_REQUEST_HMAC_KEY = originalKey }
      const row = (await client.query('SELECT * FROM mutation_requests WHERE actor_id=$1 AND request_key=$2', [person.access.userId, key])).rows[0]
      assert.deepEqual(row.response_metadata, result)
      assert.match(row.request_digest, /^[a-f0-9]{64}$/)
      assert.ok(!JSON.stringify(row).includes(input.birthDate))
      assert.ok(!JSON.stringify(row).includes(input.accountNumber))
      assert.equal(fixture.calls.slice(calls).filter(call => call.path !== '/v2.0/inquiry/real_name').length, 0, 'replacement never reauthorizes or disconnects')
    })

    await t.test('holder mismatch, bank rejection and provider failure leave the previous verified account untouched', async () => {
      const person = await member(), before = await snapshot(person.access.userId)
      const input = bank(1)
      await assert.rejects(updateBankAccount(person.access, randomUUID(), { ...input, accountHolder: '다른 예금주' }), codeIs('account_holder_mismatch'))
      assert.deepEqual(await snapshot(person.access.userId), before)
      for (const [failure, code] of [
        [{ rsp_code: 'A0000', bank_rsp_code: '411' }, 'bank_account_unverified'],
        [{ rsp_code: 'A0004' }, 'openbanking_unavailable'],
        [{ rsp_code: 'A0002', bank_rsp_code: '818' }, 'openbanking_test_data_missing'],
      ] as const) {
        globalThis.fetch = async (url, options) => new URL(String(url)).pathname === '/v2.0/inquiry/real_name' ? Response.json(failure) : fixture.provider(url, options)
        try {
          await assert.rejects(updateBankAccount(person.access, randomUUID(), input), codeIs(code))
          assert.deepEqual(await snapshot(person.access.userId), before)
        } finally { globalThis.fetch = fixture.provider }
      }
    })

    await t.test('a late inquiry cannot overwrite a newer committed representative account', async () => {
      const person = await member(), slowInput = bank(1), fastInput = bank(1)
      const gate = holdInquiry(slowInput.accountNumber)
      const slow = updateBankAccount(person.access, randomUUID(), slowInput)
      const rejected = assert.rejects(slow, codeIs('bank_account_conflict'))
      try {
        await gate.started
        await updateBankAccount(person.access, randomUUID(), fastInput)
        gate.release()
        await rejected
        const saved = await snapshot(person.access.userId)
        assert.equal(saved.account_number, fastInput.accountNumber)
        assert.equal(saved.bank_version, 2)
      } finally { gate.release(); await rejected }
    })

    await t.test('withdrawal during an inquiry blocks the late account write and any new inquiry', async () => {
      const person = await member(), input = bank(1), key = randomUUID()
      const before = await snapshot(person.access.userId), gate = holdInquiry(input.accountNumber)
      const slow = updateBankAccount(person.access, key, input)
      const rejected = assert.rejects(slow, codeIs('unauthorized'))
      try {
        await gate.started
        assert.equal((await withdrawAccount(person.access)).openBankingDisconnect, 'pending')
        gate.release()
        await rejected
        const { deleted_at, ...after } = await snapshot(person.access.userId)
        assert.ok(deleted_at)
        const { deleted_at: ignored, ...prior } = before
        assert.deepEqual(after, prior)
        assert.equal((await consent(person.access.userId)).status, 'DISCONNECT_PENDING')
        const calls = fixture.calls.length
        await assert.rejects(updateBankAccount(person.access, randomUUID(), input), codeIs('unauthorized'))
        assert.equal(fixture.calls.length, calls)
        assert.equal((await client.query('SELECT 1 FROM mutation_requests WHERE request_key=$1', [key])).rowCount, 0)
      } finally { gate.release(); await rejected }
    })

    await t.test('database failure after the bank update rolls back bank version, onboarding and successful-request metadata', async () => {
      const person = await member(), input = bank(1), key = randomUUID()
      const before = await snapshot(person.access.userId), constraint = `bank_test_${randomUUID().replaceAll('-', '')}`
      await client.query(`ALTER TABLE mutation_requests ADD CONSTRAINT ${constraint} CHECK (actor_id <> '${person.access.userId}' OR request_key <> '${key}')`)
      try {
        await assert.rejects(updateBankAccount(person.access, key, input), error => (error as { code?: string }).code === '23514')
        assert.deepEqual(await snapshot(person.access.userId), before)
        assert.equal((await client.query('SELECT 1 FROM mutation_requests WHERE request_key=$1', [key])).rowCount, 0)
      } finally { await client.query(`ALTER TABLE mutation_requests DROP CONSTRAINT ${constraint}`) }
      assert.equal((await updateBankAccount(person.access, key, input)).bankVersion, 2)

      const newcomerAccount = await newcomer()
      await fixture.authorize(newcomerAccount.access)
      const newBank = bank(), incomplete = await snapshot(newcomerAccount.access.userId)
      const sessionConstraint = `bank_session_${randomUUID().replaceAll('-', '')}`
      await client.query(`ALTER TABLE refresh_sessions ADD CONSTRAINT ${sessionConstraint} CHECK (user_id <> '${newcomerAccount.access.userId}' OR purpose <> 'app')`)
      try {
        await assert.rejects(completeOnboarding(newcomerAccount.access, newBank), error => (error as { code?: string }).code === '23514')
        assert.deepEqual(await snapshot(newcomerAccount.access.userId), incomplete)
        assert.equal((await getAccount(newcomerAccount.access, true)).purpose, 'onboarding', 'the original session revocation also rolls back')
      } finally { await client.query(`ALTER TABLE refresh_sessions DROP CONSTRAINT ${sessionConstraint}`) }
      assert.equal((await completeOnboarding(newcomerAccount.access, newBank)).purpose, 'app')
    })
  } finally {
    fixture.restore()
    process.env.DATABASE_URL = testUrl
    await client.query('SET search_path TO public')
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await client.end()
  }
})
