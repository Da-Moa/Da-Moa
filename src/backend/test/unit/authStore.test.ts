import assert from 'node:assert/strict'
import test from 'node:test'
import { accessTokenForRefresh, createRefreshToken, currentTimestamp, readAccessToken, readRefreshToken } from '../../global/auth/native.ts'

test('stateless refresh preserves purpose and never extends an onboarding access expiry', () => {
  process.env.AUTH_JWT_SECRET = 'stateless-refresh-test-secret-at-least-32-bytes'
  const now = currentTimestamp()
  const refresh = readRefreshToken(createRefreshToken('user-id', 'issuance-id', undefined, now, 30, 'onboarding'))!
  for (let i = 0; i < 2; i++) {
    const { accessToken, purpose } = accessTokenForRefresh(refresh)
    assert.equal(purpose, 'onboarding')
    assert.equal(readAccessToken(accessToken)?.purpose, 'onboarding')
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString())
    assert.equal(payload.exp, refresh.expiresAt)
  }
})
