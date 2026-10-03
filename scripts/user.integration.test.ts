import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { createAccessToken, readAccessToken } from '../src/lib/auth.ts'
import { signInKakao } from '../src/Global/Auth/Backend/index.ts'
import { createDatabaseClient } from '../src/lib/db.ts'
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
