import assert from 'node:assert/strict'
import { generateKeyPairSync, sign as signSignature } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import test from 'node:test'
import {
  ACCESS_TOKEN_MAX_AGE_SECONDS,
  authCookieOptions,
  createAccessToken,
  createKakaoAuthorizationRequest,
  createRefreshToken,
  getKakaoUserProfile,
  REFRESH_TOKEN_MAX_AGE_SECONDS,
  refreshCookieOptions,
  verifyAccessToken,
  verifyKakaoIdToken,
  verifyRefreshToken,
} from './auth.ts'

const TEST_SECRET = '0123456789abcdef0123456789abcdef'
const TEST_KAKAO_CONFIG = {
  clientId: 'client-id',
  redirectUri: 'http://localhost:3000/auth/v1/kakao',
}

type NextFetchOptions = RequestInit & { next?: { revalidate?: number } }

function createKakaoIdToken(privateKey: KeyObject, kid: string) {
  const issuedAt = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    aud: TEST_KAKAO_CONFIG.clientId,
    exp: issuedAt + 60,
    iat: issuedAt,
    iss: 'https://kauth.kakao.com',
    nonce: 'expected-nonce',
    sub: 'kakao-subject',
  })).toString('base64url')
  const signingInput = `${header}.${payload}`
  const signature = signSignature('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url')

  return `${signingInput}.${signature}`
}

test('Kakao authorization requests profile consent and uses OIDC with PKCE', () => {
  const request = createKakaoAuthorizationRequest({
    clientId: 'client-id',
    redirectUri: 'http://localhost:3000/auth/v1/kakao',
  })
  const url = new URL(request.url)

  assert.equal(url.searchParams.get('scope'), 'openid,profile_nickname,profile_image,account_email')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('state'), request.state)
  assert.equal(url.searchParams.get('nonce'), request.nonce)
  assert.notEqual(url.searchParams.get('code_challenge'), request.codeVerifier)
})

test('Kakao user info returns a verified display profile', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.toString())
    if (url.pathname === '/v1/oidc/userinfo') {
      return new Response(JSON.stringify({
        email: 'member@example.com',
        email_verified: true,
        name: '실명은 저장하지 않아요',
        nickname: '다모아 닉네임',
        picture: 'http://cdn.example.com/profile.png',
        sub: 'kakao-subject',
      }), { status: 200 })
    }

    assert.equal(url.pathname, '/v2/user/me')
    assert.equal(url.searchParams.get('secure_resource'), 'true')
    return new Response(JSON.stringify({
      kakao_account: {
        email: 'member@example.com',
        is_email_valid: true,
        is_email_verified: true,
        profile: {
          nickname: '다모아 닉네임',
          profile_image_url: 'https://cdn.example.com/profile-full.png',
        },
      },
    }), { status: 200 })
  }) as typeof fetch

  try {
    assert.deepEqual(await getKakaoUserProfile('provider-access-token', 'kakao-subject'), {
      displayName: '다모아 닉네임',
      email: 'member@example.com',
      profileImageUrl: 'https://cdn.example.com/profile-full.png',
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Kakao ID token retries the JWKS once when its cached keys lack the token kid', async () => {
  const originalFetch = globalThis.fetch
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const signingKey = {
    ...publicKey.export({ format: 'jwk' }),
    alg: 'RS256',
    kid: 'rotated-key',
    use: 'sig',
  }
  const calls: NextFetchOptions[] = []
  globalThis.fetch = (async (_input, init) => {
    calls.push((init ?? {}) as NextFetchOptions)
    return new Response(JSON.stringify({
      keys: calls.length === 1 ? [{ ...signingKey, kid: 'previous-key' }] : [signingKey],
    }), { status: 200 })
  }) as typeof fetch

  try {
    assert.equal(
      await verifyKakaoIdToken(createKakaoIdToken(privateKey, signingKey.kid), TEST_KAKAO_CONFIG, 'expected-nonce'),
      'kakao-subject',
    )
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[0].next, { revalidate: 300 })
    assert.equal(calls[1].cache, 'no-store')
    assert.equal(calls[1].next, undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Kakao ID token does not accept an invalid JWKS key with a matching kid', async () => {
  const originalFetch = globalThis.fetch
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const invalidSigningKey = {
    ...publicKey.export({ format: 'jwk' }),
    alg: 'RS256',
    kid: 'matching-key',
    use: 'enc',
  }
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response(JSON.stringify({ keys: [invalidSigningKey] }), { status: 200 })
  }) as typeof fetch

  try {
    assert.equal(
      await verifyKakaoIdToken(createKakaoIdToken(privateKey, invalidSigningKey.kid), TEST_KAKAO_CONFIG, 'expected-nonce'),
      null,
    )
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('access and refresh JWTs reject tampering, expiry, and token-type confusion', () => {
  const issuedAt = 1_000
  const access = createAccessToken('user-id', 'session-id', TEST_SECRET, issuedAt)
  const refresh = createRefreshToken('user-id', 'session-id', TEST_SECRET, issuedAt)
  const tampered = `${access.slice(0, -1)}${access.endsWith('a') ? 'b' : 'a'}`

  assert.deepEqual(verifyAccessToken(access, TEST_SECRET, issuedAt + 1), {
    issuedAt,
    sessionId: 'session-id',
    userId: 'user-id',
  })
  assert.equal(verifyAccessToken(tampered, TEST_SECRET, issuedAt + 1), null)
  assert.equal(verifyRefreshToken(access, TEST_SECRET, issuedAt + 1), null)
  assert.equal(verifyAccessToken(access, TEST_SECRET, issuedAt + ACCESS_TOKEN_MAX_AGE_SECONDS), null)
  assert.equal(verifyRefreshToken(refresh, TEST_SECRET, issuedAt + REFRESH_TOKEN_MAX_AGE_SECONDS), null)
  assert.equal(authCookieOptions(ACCESS_TOKEN_MAX_AGE_SECONDS).maxAge, ACCESS_TOKEN_MAX_AGE_SECONDS)
  assert.equal(refreshCookieOptions(REFRESH_TOKEN_MAX_AGE_SECONDS).maxAge, REFRESH_TOKEN_MAX_AGE_SECONDS)
  assert.equal(refreshCookieOptions(REFRESH_TOKEN_MAX_AGE_SECONDS).path, '/api/auth')
})
