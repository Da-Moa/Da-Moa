import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { networkInterfaces } from 'node:os'
import { NextRequest } from 'next/server'
import { POST } from '../src/app/api/auth/test-login/route.ts'
import { POST as accessTokenResponse } from '../src/app/api/auth/access-token/route.ts'
import { ACCESS_TOKEN_COOKIE_NAME, readAccessToken, REFRESH_TOKEN_COOKIE_NAME } from '../src/lib/auth.ts'
import { getAccount } from '../src/lib/authorization.ts'
import { completeOnboarding } from '../src/Domain/User/Backend/index.ts'
import { signInTestAccount } from '../src/Global/Auth/Backend/index.ts'
import { createDatabaseClient } from '../src/lib/db.ts'
import { TEST_ACCOUNTS, TEST_ONBOARDING_KEY } from '../src/lib/test-accounts.ts'
import { applyMigrations } from './migrations.mjs'

const testUrl = process.env.TEST_DATABASE_URL
if (!testUrl || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(testUrl).hostname) || !new URL(testUrl).pathname.toLowerCase().includes('test')) {
  throw new Error('TEST_DATABASE_URL must name an isolated local test database')
}
process.env.DATABASE_URL = testUrl
process.env.AUTH_JWT_SECRET = 'isolated-test-login-secret-at-least-32-bytes'

before(async () => {
  const client = createDatabaseClient(testUrl)
  try {
    await client.connect()
    await applyMigrations(client)
    for (const account of TEST_ACCOUNTS) await client.query(`
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

test('local development test login issues only a Refresh cookie and bootstraps a Bearer Access JWT and rejects untrusted input', async () => {
  for (const account of TEST_ACCOUNTS) {
    const response = await POST(loginRequest(account.key))
    assert.equal(response.status, 303, account.key)
    assert.equal(response.headers.get('location'), 'http://localhost/auth/complete?returnTo=%2Fhome%2Fhistory')
    const cookies = response.headers.getSetCookie()
    const accessCookie = cookies.find(cookie => cookie.startsWith(`${ACCESS_TOKEN_COOKIE_NAME}=`))
    const refreshCookie = cookies.find(cookie => cookie.startsWith(`${REFRESH_TOKEN_COOKIE_NAME}=`))
    assert.match(accessCookie ?? '', /Max-Age=0/)
    assert.match(refreshCookie ?? '', /HttpOnly/)
    assert.match(refreshCookie ?? '', /Path=\/api\/auth/)
    const issued = await accessTokenResponse(new NextRequest('http://localhost/api/auth/access-token', { method: 'POST', headers: { origin: 'http://localhost', cookie: refreshCookie?.split(';')[0] ?? '' } }))
    assert.equal(issued.status, 200)
    const access = readAccessToken((await issued.json()).data.accessToken)
    assert.ok(access)
    assert.equal((await getAccount(access)).id, account.id)
  }

  assert.equal((await POST(loginRequest('unknown'))).status, 404)
  assert.equal((await POST(loginRequest(TEST_ACCOUNTS[0].key, 'https://evil.test'))).status, 403)
  assert.equal((await POST(loginRequest(TEST_ACCOUNTS[0].key, 'http://localhost', '&extra=1'))).status, 400)
})

const localAddress = Object.values(networkInterfaces()).flat().find(entry => entry?.family === 'IPv4' && !entry.internal && /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(entry.address))?.address
test('development test login works at the server LAN address and preserves origin and production restrictions', { skip: !localAddress }, async () => {
  const origin = `http://${localAddress}:3000`
  function request(requestOrigin = origin) {
    return new NextRequest(`${origin}/api/auth/test-login`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: requestOrigin },
      body: new URLSearchParams({ key: TEST_ACCOUNTS[0].key, returnTo: '/home' }).toString(),
    })
  }
  const response = await POST(request())
  assert.equal(response.status, 303)
  assert.equal(response.headers.get('location'), `${origin}/auth/complete?returnTo=%2Fhome`)
  assert.ok(response.headers.getSetCookie().some(cookie => cookie.startsWith(`${REFRESH_TOKEN_COOKIE_NAME}=`)))
  assert.equal((await POST(request('http://evil.test'))).status, 403)
  const previousEnv = { NODE_ENV: process.env.NODE_ENV, KAKAO_REDIRECT_URI: process.env.KAKAO_REDIRECT_URI }
  try {
    Object.assign(process.env, { NODE_ENV: 'production', KAKAO_REDIRECT_URI: `${origin}/api/auth/kakao/callback` })
    assert.equal((await POST(request())).status, 404)
  } finally {
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test('onboarding preview creates a fresh limited test session on every click and completes registration', async () => {
  const ids = new Set<string>()
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await POST(loginRequest(TEST_ONBOARDING_KEY))
    assert.equal(response.status, 303)
    const refreshCookie = response.headers.getSetCookie().find(cookie => cookie.startsWith(`${REFRESH_TOKEN_COOKIE_NAME}=`))
    const issued = await accessTokenResponse(new NextRequest('http://localhost/api/auth/access-token', { method: 'POST', headers: { origin: 'http://localhost', cookie: refreshCookie?.split(';')[0] ?? '' } }))
    assert.equal(issued.status, 200)
    const access = readAccessToken((await issued.json()).data.accessToken)
    assert.ok(access)
    const account = await getAccount(access, true)
    assert.equal(account.displayName, '민지')
    assert.equal(account.purpose, 'onboarding')
    assert.equal(account.onboardingCompletedAt, null)
    assert.equal(account.deletedAt, null)
    assert.equal(account.accountNumber, null)
    assert.equal(account.bankVersion, 0)
    ids.add(account.id)
    await assert.rejects(getAccount(access), { code: 'onboarding_required' })
    const session = await completeOnboarding(access, {
      bankCode: '090', accountNumber: '3333123456789', accountHolder: '민지', expectedBankVersion: 0,
    })
    const completed = await getAccount(readAccessToken(session.accessToken))
    assert.equal(completed.id, account.id)
    assert.equal(completed.purpose, 'app')
  }
  assert.equal(ids.size, 2)
  assert.equal((await POST(loginRequest(TEST_ONBOARDING_KEY, 'https://evil.test'))).status, 403)
  const previousEnv = { NODE_ENV: process.env.NODE_ENV, KAKAO_REDIRECT_URI: process.env.KAKAO_REDIRECT_URI }
  try {
    Object.assign(process.env, { NODE_ENV: 'production', KAKAO_REDIRECT_URI: 'http://localhost/auth/v1/kakao' })
    assert.equal((await POST(loginRequest(TEST_ONBOARDING_KEY))).status, 404)
    assert.throws(() => signInTestAccount(TEST_ONBOARDING_KEY), { code: 'not_found' })
  } finally {
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})
