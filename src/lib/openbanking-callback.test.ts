import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { readAccessToken } from './auth.ts'
import { encryptOpenBankingSecret } from './openbanking.ts'
import { createOpenBankingCallbackCookie, openBankingCallbackCookieOptions, readOpenBankingCallbackCookie } from './openbanking-callback.ts'

test('OAuth callback proof outlasts the app access cookie but is state-bound, short-lived and not an app token', () => {
  const originalKey = process.env.OPENBANKING_TOKEN_ENCRYPTION_KEY
  process.env.OPENBANKING_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
  try {
    const now = 1_800_000_000, state = 'a'.repeat(32)
    const access = { userId: randomUUID(), sessionId: randomUUID(), issuedAt: now }
    const cookie = createOpenBankingCallbackCookie(access, state, now)
    assert.deepEqual(readOpenBankingCallbackCookie(cookie, state, now + 360), access)
    assert.equal(readOpenBankingCallbackCookie(cookie, state, now + 600), null)
    assert.equal(readOpenBankingCallbackCookie(cookie, 'b'.repeat(32), now), null)
    assert.equal(readOpenBankingCallbackCookie(`${cookie}x`, state, now), null)
    assert.equal(readOpenBankingCallbackCookie(cookie, state, now - 1), null)
    assert.equal(readAccessToken(cookie), null)
    assert.ok(!cookie.includes(access.userId))
    const options = openBankingCallbackCookieOptions()
    assert.deepEqual({ path: options.path, maxAge: options.maxAge, httpOnly: options.httpOnly, sameSite: options.sameSite }, { path: '/auth/v1/openbanking', maxAge: 600, httpOnly: true, sameSite: 'lax' })
    for (const payload of [null, [], { ...access, expiresAt: now + 601 }, { ...access, expiresAt: now + 600, purpose: 'app' }, { ...access, userId: '', expiresAt: now + 600 }, { ...access, expiresAt: String(now + 600) }]) {
      assert.equal(readOpenBankingCallbackCookie(encryptOpenBankingSecret(JSON.stringify(payload), `oauth-session:${state}`), state, now), null)
    }
    assert.throws(() => createOpenBankingCallbackCookie(access, 'bad-state', now))
  } finally {
    if (originalKey === undefined) delete process.env.OPENBANKING_TOKEN_ENCRYPTION_KEY
    else process.env.OPENBANKING_TOKEN_ENCRYPTION_KEY = originalKey
  }
})
