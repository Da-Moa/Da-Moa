import assert from 'node:assert/strict'
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
  verifyRefreshToken,
} from './auth.ts'

const TEST_SECRET = '0123456789abcdef0123456789abcdef'

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
