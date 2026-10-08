import { before } from 'node:test'
import { getPrismaClient } from '../../global/database/prisma.service.ts'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { test } from 'node:test'
import { HttpRequest as NextRequest } from '../../global/apiPayload/httpContext'
import { getKakaoLoginResponse as login } from '../../global/auth'
import { getKakaoCallbackResponse as callback } from '../domainTestSupport';
import { OIDC_COOKIE_NAMES, readRefreshToken, REFRESH_TOKEN_COOKIE_NAME } from '../../global/auth/native.ts'
import { createDatabaseClient } from '../../global/database/db.ts'
import { applyMigrations } from '../../../../scripts/migrations.mjs'

const database = process.env.TEST_DATABASE_URL
if (!database || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(database).hostname) || !new URL(database).pathname.toLowerCase().includes('test')) {
  throw new Error('TEST_DATABASE_URL must name an isolated local test database')
}
process.env.DATABASE_URL = database

test('Kakao callbacks keep the selected URI for localhost and LAN and reject untrusted origins or cookies', async () => {
  const previous = Object.fromEntries(['NODE_ENV', 'AUTH_JWT_SECRET', 'KAKAO_REST_API_KEY', 'KAKAO_REDIRECT_URI'].map(key => [key, process.env[key]]))
  Object.assign(process.env, { NODE_ENV: 'development', AUTH_JWT_SECRET: 'isolated-kakao-redirect-test-secret-at-least-32-bytes', KAKAO_REST_API_KEY: 'isolated-client-id' })
  const originalFetch = globalThis.fetch
  const local = 'http://localhost:3000/auth/v1/kakao'
  const lan = 'http://192.168.219.102:3000/auth/v1/kakao'
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const key = { ...publicKey.export({ format: 'jwk' }), alg: 'RS256', use: 'sig', kid: `redirect-${randomUUID()}` }
  const db = createDatabaseClient(database)
  let providerCalls = 0
  let expectedUri = '', expectedNonce = '', subject = ''
  globalThis.fetch = (async (input, init) => {
    providerCalls++
    const url = new URL(String(input))
    if (url.href === 'https://kauth.kakao.com/oauth/token') {
      const body = new URLSearchParams(String(init?.body))
      assert.equal(body.get('redirect_uri'), expectedUri, 'authorization and token requests use the identical registered URI')
      assert.equal(body.get('grant_type'), 'authorization_code')
      assert.ok(body.get('code_verifier'))
      const now = Math.floor(Date.now() / 1000)
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: key.kid })).toString('base64url')
      const payload = Buffer.from(JSON.stringify({ iss: 'https://kauth.kakao.com', aud: 'isolated-client-id', sub: subject, nonce: expectedNonce, iat: now, exp: now + 60 })).toString('base64url')
      const content = `${header}.${payload}`
      const idToken = `${content}.${sign('RSA-SHA256', Buffer.from(content), privateKey).toString('base64url')}`
      return new Response(JSON.stringify({ access_token: 'test-provider-token', id_token: idToken }))
    }
    if (url.href === 'https://kauth.kakao.com/.well-known/jwks.json') return new Response(JSON.stringify({ keys: [key] }))
    if (url.href === 'https://kapi.kakao.com/v1/oidc/userinfo') return new Response(JSON.stringify({ sub: subject, nickname: '콜백 검증' }))
    throw new Error(`Unexpected provider endpoint: ${url.pathname}`)
  }) as typeof fetch
  const request = (uri: string, cookies: Record<string, string>, state: string) => new NextRequest(`${uri}?code=isolated-code&state=${state}`, {
    headers: { cookie: Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join('; ') },
  })
  try {
    await db.connect()
    await applyMigrations(db)
    for (const uri of [local, lan]) {
      process.env.KAKAO_REDIRECT_URI = `${local}, ${lan}`
      const origin = new URL(uri).origin
      const start = await login(new NextRequest(`${origin}/api/auth/kakao?returnTo=/home/groups`))
      assert.equal(start.status, 307)
      const authorize = new URL(start.headers.get('location')!)
      assert.equal(authorize.searchParams.get('redirect_uri'), uri)
      const cookies = Object.fromEntries(start.cookies.getAll().map(({ name, value }) => [name, value]))
      assert.ok(cookies[OIDC_COOKIE_NAMES.redirectUri])
      assert.match(start.headers.getSetCookie().find(value => value.startsWith(`${OIDC_COOKIE_NAMES.redirectUri}=`))!, /HttpOnly/)
      expectedUri = uri
      expectedNonce = authorize.searchParams.get('nonce')!
      subject = `redirect-test:${randomUUID()}`
      // A reordered list and another callback on this origin must not change the saved URI.
      process.env.KAKAO_REDIRECT_URI = `${origin}/alternative-callback,${lan},${local}`
      const finish = await callback(request(uri, cookies, authorize.searchParams.get('state')!))
      assert.equal(finish.status, 307)
      assert.equal(new URL(finish.headers.get('location')!).origin, origin)
      assert.equal(new URL(finish.headers.get('location')!).pathname, '/auth/complete')
      const refresh = readRefreshToken(finish.cookies.get(REFRESH_TOKEN_COOKIE_NAME)?.value)
      assert.ok(refresh)
      assert.equal((await db.query("SELECT provider_subject FROM users WHERE id=$1 AND provider='kakao'", [refresh.userId])).rows[0].provider_subject, subject)
      for (const name of Object.values(OIDC_COOKIE_NAMES)) assert.equal(finish.cookies.get(name)?.maxAge, 0)
    }

    process.env.KAKAO_REDIRECT_URI = `${local},${lan}`
    const denied = await login(new NextRequest('http://attacker.example/api/auth/kakao'))
    assert.equal(new URL(denied.headers.get('location')!).searchParams.get('error'), 'configuration')
    assert.equal(denied.cookies.getAll().length, 0)
    const start = await login(new NextRequest('http://localhost:3000/api/auth/kakao'))
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!
    const cookies = Object.fromEntries(start.cookies.getAll().map(({ name, value }) => [name, value]))
    const callsBefore = providerCalls
    const missing = { ...cookies }; delete missing[OIDC_COOKIE_NAMES.redirectUri]
    for (const [uri, values] of [
      [lan, cookies],
      [local, { ...cookies, [OIDC_COOKIE_NAMES.redirectUri]: `${cookies[OIDC_COOKIE_NAMES.redirectUri]}x` }],
      [local, missing],
    ] as const) {
      const deniedCallback = await callback(request(uri, values, state))
      assert.equal(new URL(deniedCallback.headers.get('location')!).pathname, '/login')
      assert.equal(deniedCallback.cookies.get(REFRESH_TOKEN_COOKIE_NAME), undefined)
    }
    assert.equal(providerCalls, callsBefore, 'invalid callbacks never exchange a provider code')
    // Old single-URI logins may finish without the newly introduced cookie.
    process.env.KAKAO_REDIRECT_URI = local
    expectedUri = local; expectedNonce = cookies[OIDC_COOKIE_NAMES.nonce]; subject = `legacy-redirect:${randomUUID()}`
    assert.equal(new URL((await callback(request(local, missing, state))).headers.get('location')!).pathname, '/auth/complete')
  } finally {
    globalThis.fetch = originalFetch
    await db.end()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  }
})

before(async () => { await getPrismaClient(process.env.TEST_DATABASE_URL!) })
