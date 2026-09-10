import assert from 'node:assert/strict'
import test from 'node:test'
import { createReturnToCookie, readReturnToCookie, safeReturnTo } from './auth.ts'

const secret = 'test-secret-only-for-return-destination-signatures'

test('return destinations only allow local application routes without decoding bypasses', () => {
  for (const valid of ['/home', '/home/history', '/home/rounds/r-1', '/invites/A_b-C', '/settlements/r-1']) {
    assert.equal(safeReturnTo(valid), valid)
  }
  for (const invalid of ['https://evil.test', '//evil.test', '/\\evil.test', '/home/%2e%2e/login', '/home/../login', '/login', '/api/auth/kakao', '/invites/a?returnTo=https://evil.test', '/home%2f%2fevil.test', '/invites/a\n']) {
    assert.equal(safeReturnTo(invalid), '/home')
  }
})

test('return destination cookie is signed, expiring, and bound to the OIDC state', () => {
  const token = createReturnToCookie('/settlements/r-1', 'oidc-state', secret, 100)
  assert.equal(readReturnToCookie(token, 'oidc-state', secret, 101), '/settlements/r-1')
  assert.equal(readReturnToCookie(token, undefined, secret, 101), '/settlements/r-1')
  assert.equal(readReturnToCookie(token, 'wrong-state', secret, 101), '/home')
  assert.equal(readReturnToCookie(token, 'oidc-state', secret, 700), '/home')
  assert.equal(readReturnToCookie(`${token}x`, 'oidc-state', secret, 101), '/home')
  assert.equal(readReturnToCookie(undefined), '/home')
})
