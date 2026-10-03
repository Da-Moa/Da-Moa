import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { createAccessToken, currentTimestamp, readAccessToken } from '../src/lib/auth.ts'
import { signInKakao } from '../src/Global/Auth/Backend/index.ts'
import { completeOnboarding } from '../src/Domain/User/Backend/index.ts'
import { findUser, saveOnboarding } from '../src/Domain/User/Backend/Repository/UserRepository.ts'
import { normalizeBankAccountInput } from '../src/Domain/User/Shared/index.ts'
import { createDatabaseClient, withDatabaseConnection } from '../src/lib/db.ts'
import { getDatabasePool } from '../src/lib/db-client.mjs'
import { GET } from '../src/app/api/me/route.ts'
import { applyMigrations } from './migrations.mjs'
import { completeTestOnboarding } from './bank-test-support.ts'

const database = process.env.TEST_DATABASE_URL
if (!database || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(database).hostname) || !new URL(database).pathname.toLowerCase().includes('test')) throw new Error('TEST_DATABASE_URL must name an isolated local test database')
process.env.DATABASE_URL = database
process.env.AUTH_JWT_SECRET ||= 'isolated-user-test-secret-at-least-32-bytes'

test('GET /api/me uses one AUTH SELECT without transaction SQL for app, onboarding and rejected user states', async t => {
  const client = createDatabaseClient(database)
  await client.connect()
  const previousLog = process.env.DB_QUERY_LOG
  try {
    await applyMigrations(client)
    const profile = { displayName: '내 정보 검증', email: null, profileImageUrl: null }
    const limited = await signInKakao(`user-me:${randomUUID()}`, profile)
    const appSignup = await signInKakao(`user-me:${randomUUID()}`, profile)
    const app = await completeTestOnboarding(readAccessToken(appSignup.accessToken), { bankName: '검증은행', accountNumber: '001234', accountHolder: profile.displayName })
    const rejoining = await signInKakao(`user-me:${randomUUID()}`, profile)
    await client.query('UPDATE users SET deleted_at=1 WHERE id=$1', [rejoining.userId])

    process.env.DB_QUERY_LOG = 'true'
    let statements: string[] = []
    t.mock.method(console, 'info', (message: string) => { statements.push(message.replace(/^SQL:\s*/, '').replace(/\s+/g, ' ').trim()) })
    for (const [token, status, purpose] of [
      [app.accessToken, 200, 'app'],
      [limited.accessToken, 200, 'onboarding'],
      [appSignup.accessToken, 401, undefined],
      [rejoining.accessToken, 200, 'onboarding'],
      [createAccessToken(rejoining.userId, randomUUID()), 401, undefined],
      [createAccessToken(randomUUID(), randomUUID()), 401, undefined],
    ] as const) {
      statements = []
      const response = await GET(new NextRequest('http://localhost/api/me', { headers: { authorization: `Bearer ${token}` } }))
      assert.equal(response.status, status)
      assert.equal(response.headers.get('cache-control'), 'private, no-store')
      assert.equal(statements.length, 1, statements.join('\n'))
      assert.match(statements[0], /^SELECT .* FROM users u WHERE u\.id = \$1$/)
      assert.doesNotMatch(statements[0], /\b(?:BEGIN|COMMIT|ROLLBACK|SET)\b|pg_advisory|FOR UPDATE|FOR SHARE/)
      const body = await response.json()
      if (status === 200) {
        assert.equal(body.data.purpose, purpose)
        assert.equal(body.data.displayName, profile.displayName)
        assert.equal(body.data.bankAccount?.accountNumber ?? null, purpose === 'app' ? '001234' : null)
      } else assert.equal(body.error, 'unauthorized')
    }
    statements = []
    assert.equal((await GET(new NextRequest('http://localhost/api/me'))).status, 401)
    assert.equal(statements.length, 0)
    const pool = getDatabasePool(database)
    assert.equal(pool.idleCount, pool.totalCount, 'all borrowed connections are returned after success and rejection')
  } finally {
    if (previousLog === undefined) delete process.env.DB_QUERY_LOG
    else process.env.DB_QUERY_LOG = previousLog
    await client.end()
  }
})

test('onboarding uses AUTH + conditional UPDATE; concurrent signup/rejoin has one winner even at the same timestamp', async t => {
  const client = createDatabaseClient(database)
  await client.connect()
  const previousLog = process.env.DB_QUERY_LOG
  const profile = { displayName: '온보딩 검증', email: null, profileImageUrl: null }
  const input = { bankCode: '004', accountNumber: '001234', accountHolder: profile.displayName, expectedBankVersion: 0 }
  const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected
  let statements: string[] = []
  try {
    await applyMigrations(client)
    const signup = await signInKakao(`user-onboarding:${randomUUID()}`, profile)
    const access = readAccessToken(signup.accessToken)
    process.env.DB_QUERY_LOG = 'true'
    t.mock.method(console, 'info', (message: string) => { statements.push(message.replace(/^SQL:\s*/, '').replace(/\s+/g, ' ').trim()) })
    const trace = async <T>(count: number, work: () => Promise<T>) => {
      statements = []
      const result = await work()
      assert.equal(statements.length, count, statements.join('\n'))
      assert.doesNotMatch(statements.join('\n'), /^(?:BEGIN|COMMIT|ROLLBACK|SET)\b|pg_advisory|FOR UPDATE|FOR SHARE/m)
      if (count) assert.match(statements[0], /^SELECT .* FROM users u WHERE u\.id = \$1$/)
      if (count === 2) assert.match(statements[1], /^UPDATE users SET .* WHERE id = \$1 AND updated_at = \$8 AND bank_version = \$9/)
      return result
    }
    await trace(0, () => assert.rejects(completeOnboarding(null, input), code('unauthorized')))
    await trace(0, () => assert.rejects(completeOnboarding(access, { ...input, bankCode: 'invalid' }), code('invalid_input')))
    await trace(1, () => assert.rejects(completeOnboarding(access, { ...input, expectedBankVersion: 1 }), code('bank_account_conflict')))
    const secret = process.env.AUTH_JWT_SECRET
    delete process.env.AUTH_JWT_SECRET
    try {
      await trace(1, () => assert.rejects(completeOnboarding(access, input), /AUTH_JWT_SECRET/))
    } finally { process.env.AUTH_JWT_SECRET = secret }
    const app = await trace(2, () => completeOnboarding(access, input))
    assert.equal(readAccessToken(app.accessToken)?.purpose, 'app')
    await trace(1, () => assert.rejects(completeOnboarding(access, input), code('unauthorized')))
    await trace(1, () => assert.rejects(completeOnboarding(readAccessToken(app.accessToken), { ...input, expectedBankVersion: 1 }), code('already_onboarded')))

    const rejoin = await signInKakao(`user-onboarding:${randomUUID()}`, profile)
    await client.query('UPDATE users SET deleted_at=1 WHERE id=$1', [rejoin.userId])
    await trace(1, () => assert.rejects(completeOnboarding(readAccessToken(rejoin.accessToken), input), code('rejoin_confirmation_required')))
    await trace(2, () => completeOnboarding(readAccessToken(rejoin.accessToken), { ...input, confirmRejoin: true }))

    for (const rejoining of [false, true]) {
      const limited = await signInKakao(`user-onboarding-race:${randomUUID()}`, profile)
      if (rejoining) await client.query(`UPDATE users SET deleted_at=1, onboarding_completed_at=1,
        bank_name='국민은행', account_number='999', account_holder=$2, bank_updated_at=1,
        bank_code='004', bank_verified_at=1, bank_verification_tran_id='test-verification', bank_version=3 WHERE id=$1`, [limited.userId, profile.displayName])
      const bank = { ...input, expectedBankVersion: rejoining ? 3 : 0, confirmRejoin: rejoining }
      statements = []
      const outcomes = await Promise.allSettled(Array.from({ length: 6 }, (_, index) =>
        completeOnboarding(readAccessToken(limited.accessToken), { ...bank, accountNumber: `00123${index}` })))
      const winners = outcomes.filter(outcome => outcome.status === 'fulfilled')
      assert.equal(winners.length, 1)
      for (const outcome of outcomes) if (outcome.status === 'rejected') assert.ok(['unauthorized', 'bank_account_conflict'].includes(outcome.reason.code))
      assert.doesNotMatch(statements.join('\n'), /^(?:BEGIN|COMMIT|ROLLBACK|SET)\b|pg_advisory|FOR UPDATE|FOR SHARE/m)
      const winner = outcomes.findIndex(outcome => outcome.status === 'fulfilled')
      const saved = (await client.query('SELECT bank_version, account_number, deleted_at, bank_verified_at FROM users WHERE id=$1', [limited.userId])).rows[0]
      assert.equal(Number(saved.bank_version), bank.expectedBankVersion + 1)
      assert.equal(saved.account_number, `00123${winner}`)
      assert.equal(saved.deleted_at, null)
      assert.equal(saved.bank_verified_at, null)

      // Keep updated_at unchanged to prove second-resolution timestamps cannot admit a second save.
      await client.query('UPDATE users SET deleted_at=$2, updated_at=$2 WHERE id=$1', [limited.userId, currentTimestamp()])
      const snapshot = (await withDatabaseConnection(connection => findUser(connection, limited.userId)))!
      const normalized = normalizeBankAccountInput({ ...bank, expectedBankVersion: Number(snapshot.bank_version) }, { onboarding: true })
      await client.query('UPDATE users SET updated_at=updated_at+1 WHERE id=$1', [limited.userId])
      assert.equal(await withDatabaseConnection(connection => saveOnboarding(connection, limited.userId, normalized,
        Number(snapshot.updated_at), Number(snapshot.updated_at))), false, 'a changed AUTH snapshot must be rejected')
      await client.query('UPDATE users SET updated_at=$2 WHERE id=$1', [limited.userId, snapshot.updated_at])
      const savedCopies = await Promise.all(Array.from({ length: 6 }, () => withDatabaseConnection(connection =>
        saveOnboarding(connection, limited.userId, normalized, Number(snapshot.updated_at), Number(snapshot.updated_at)))))
      assert.equal(savedCopies.filter(Boolean).length, 1)
    }
    const pool = getDatabasePool(database)
    assert.equal(pool.idleCount, pool.totalCount)
  } finally {
    if (previousLog === undefined) delete process.env.DB_QUERY_LOG
    else process.env.DB_QUERY_LOG = previousLog
    await client.end()
  }
})
