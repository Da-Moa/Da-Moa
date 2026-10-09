import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ACCESS_TOKEN_MAX_AGE_SECONDS,
  ONBOARDING_MAX_AGE_SECONDS,
  authCookieOptions,
  createRedirectUriCookie,
  getKakaoConfig,
  getKakaoRedirectUris,
  REFRESH_TOKEN_MAX_AGE_SECONDS,
  refreshCookieOptions,
  readRedirectUriCookie,
} from '../../global/auth/native.ts'
import {
  createAccessToken,
  createRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from '../support/legacyTokenTestSupport.ts'

const TEST_SECRET = '0123456789abcdef0123456789abcdef'
const TEST_KAKAO_CONFIG = {
  clientId: 'client-id',
  redirectUri: 'http://localhost:3000/auth/v1/kakao',
}

test('카카오 URI 목록이 설정된 Origin만 선택하고 콜백 값을 그대로 유지한다', () => {
  const previous = { KAKAO_REDIRECT_URI: process.env.KAKAO_REDIRECT_URI, KAKAO_REST_API_KEY: process.env.KAKAO_REST_API_KEY }
  const local = 'http://localhost:3000/auth/v1/kakao'
  const network = 'http://192.168.219.102:3000/auth/v1/kakao'
  try {
    process.env.KAKAO_REST_API_KEY = 'test-client'
    process.env.KAKAO_REDIRECT_URI = ` ${local}, ${network}, ${local} `
    assert.deepEqual(getKakaoRedirectUris(), [local, network])
    assert.equal(getKakaoConfig(new URL('http://localhost:3000')).redirectUri, local)
    assert.equal(getKakaoConfig(new URL('http://192.168.219.102:3000')).redirectUri, network)
    for (const origin of [null, new URL('http://localhost:3001'), new URL('https://localhost:3000'), new URL('http://attacker.example')]) {
      assert.throws(() => getKakaoConfig(origin))
    }
    assert.throws(() => getKakaoConfig(new URL('http://localhost:3000'), network))
    process.env.KAKAO_REDIRECT_URI = local
    assert.equal(getKakaoConfig().redirectUri, local, 'single URI remains compatible')
    for (const invalid of ['javascript:alert(1)', 'http://user:pass@localhost:3000/auth/v1/kakao', `${local}?next=evil`, `${local}#fragment`, 'https:example.com']) {
      process.env.KAKAO_REDIRECT_URI = `${local},${invalid}`
      assert.throws(() => getKakaoRedirectUris())
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  }
})

test('선택한 카카오 콜백 쿠키를 상태 값과 연결하고 만료·변조를 거부한다', () => {
  const uri = TEST_KAKAO_CONFIG.redirectUri
  const token = createRedirectUriCookie(uri, 'login-state', TEST_SECRET, 1000)
  assert.equal(readRedirectUriCookie(token, 'login-state', TEST_SECRET, 1001), uri)
  assert.equal(readRedirectUriCookie(token, 'other-state', TEST_SECRET, 1001), null)
  assert.equal(readRedirectUriCookie(token, 'login-state', TEST_SECRET, 1600), null)
  assert.equal(readRedirectUriCookie(`${token}x`, 'login-state', TEST_SECRET, 1001), null)
  const payload = Buffer.from(JSON.stringify({ redirectUri: 'https://evil.example/auth/v1/kakao', state: 'login-state', exp: 1600 })).toString('base64url')
  assert.equal(readRedirectUriCookie(`${payload}.${token.split('.')[1]}`, 'login-state', TEST_SECRET, 1001), null)
  assert.equal(readRedirectUriCookie(undefined, 'login-state', TEST_SECRET, 1001), null)
})

test('접근·갱신 JWT의 변조·만료·토큰 종류 혼동을 거부한다', () => {
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
  assert.equal(authCookieOptions(ACCESS_TOKEN_MAX_AGE_SECONDS).maxAge, ACCESS_TOKEN_MAX_AGE_SECONDS * 1000)
  assert.equal(refreshCookieOptions(REFRESH_TOKEN_MAX_AGE_SECONDS).maxAge, REFRESH_TOKEN_MAX_AGE_SECONDS * 1000)
  assert.equal(refreshCookieOptions(REFRESH_TOKEN_MAX_AGE_SECONDS).path, '/api/auth')

  const onboarding = createAccessToken('user-id', 'limited-session', TEST_SECRET, issuedAt, ONBOARDING_MAX_AGE_SECONDS)
  assert.equal(ACCESS_TOKEN_MAX_AGE_SECONDS, 600)
  assert.ok(verifyAccessToken(onboarding, TEST_SECRET, issuedAt + ONBOARDING_MAX_AGE_SECONDS - 1))
  assert.equal(verifyAccessToken(onboarding, TEST_SECRET, issuedAt + ONBOARDING_MAX_AGE_SECONDS), null)
  const limited = createAccessToken('user-id', 'limited-session', TEST_SECRET, issuedAt, ONBOARDING_MAX_AGE_SECONDS, 'onboarding')
  assert.equal(verifyAccessToken(limited, TEST_SECRET, issuedAt + 1)?.purpose, 'onboarding')
})
