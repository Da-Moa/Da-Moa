import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { NextRequest } from 'next/server'
import { POST } from '../src/app/api/auth/test-login/route.ts'
import { ACCESS_TOKEN_COOKIE_NAME, readAccessToken, REFRESH_TOKEN_COOKIE_NAME } from '../src/lib/auth.ts'
import { getAccount } from '../src/lib/authorization.ts'
import { createDatabaseClient } from '../src/lib/db.ts'
import { TEST_ACCOUNTS } from '../src/lib/test-accounts.ts'
import { applyMigrations } from './migrations.mjs'

const testUrl = process.env.TEST_DATABASE_URL
if (!testUrl || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(testUrl).hostname) || !new URL(testUrl).pathname.toLowerCase().includes('test')) {
  throw new Error('TEST_DATABASE_URL must name an isolated local test database')
}
process.env.DATABASE_URL = testUrl
process.env.AUTH_JWT_SECRET = 'isolated-test-login-secret-at-least-32-bytes'

before(async () => {
  const client = createDatabaseClient(testUrl)
  const account = TEST_ACCOUNTS[0]
  try {
    await client.connect()
    await applyMigrations(client)
    await client.query(`
      INSERT INTO users(id,provider,provider_subject,display_name,email,created_at,updated_at,onboarding_completed_at,bank_name,account_number,account_holder,bank_updated_at)
      VALUES($1,'test',$2,$3,$4,1,1,1,$5,$6,$7,1)
      ON CONFLICT (provider,provider_subject) DO UPDATE SET deleted_at=NULL,onboarding_completed_at=1,
        bank_name=EXCLUDED.bank_name,account_number=EXCLUDED.account_number,account_holder=EXCLUDED.account_holder
    `, [account.id, account.providerSubject, account.displayName, account.email, account.bankName, account.accountNumber, account.accountHolder])
  } finally { await client.end() }
})

function loginRequest(key: string, origin = 'http://localhost', extra = '') {
  const body = new URLSearchParams({ key, returnTo: '/home/history' }).toString() + extra
  return new NextRequest('http://localhost/api/auth/test-login', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin }, body,
  })
}

test('local development test login issues an authenticated cookie pair and rejects untrusted input', async () => {
  const response = await POST(loginRequest(TEST_ACCOUNTS[0].key))
  assert.equal(response.status, 303)
  assert.equal(response.headers.get('location'), 'http://localhost/home/history')
  const cookies = response.headers.getSetCookie()
  const accessCookie = cookies.find(cookie => cookie.startsWith(`${ACCESS_TOKEN_COOKIE_NAME}=`))
  const refreshCookie = cookies.find(cookie => cookie.startsWith(`${REFRESH_TOKEN_COOKIE_NAME}=`))
  assert.match(accessCookie ?? '', /HttpOnly/)
  assert.match(refreshCookie ?? '', /HttpOnly/)
  assert.match(refreshCookie ?? '', /Path=\/api\/auth/)
  const access = readAccessToken(accessCookie?.slice(ACCESS_TOKEN_COOKIE_NAME.length + 1).split(';')[0])
  assert.ok(access)
  assert.equal((await getAccount(access)).id, TEST_ACCOUNTS[0].id)

  assert.equal((await POST(loginRequest('unknown'))).status, 404)
  assert.equal((await POST(loginRequest(TEST_ACCOUNTS[0].key, 'https://evil.test'))).status, 403)
  assert.equal((await POST(loginRequest(TEST_ACCOUNTS[0].key, 'http://localhost', '&extra=1'))).status, 400)
})
