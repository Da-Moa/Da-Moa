import assert from 'node:assert/strict'
import test from 'node:test'
import { createReturnToCookie, readReturnToCookie, safeReturnTo } from '../../global/auth/native.ts'

const secret = 'test-secret-only-for-return-destination-signatures'

test('돌아갈 목적지를 로컬 앱 경로로 제한하고 디코딩 우회를 거부한다', () => {
  for (const valid of ['/home', '/home/history', '/home/rounds/r-1', '/invites/A_b-C', '/settlements/r-1']) {
    assert.equal(safeReturnTo(valid), valid)
  }
  for (const invalid of ['https://evil.test', '//evil.test', '/\\evil.test', '/home/%2e%2e/login', '/home/../login', '/login', '/api/auth/kakao', '/invites/a?returnTo=https://evil.test', '/home%2f%2fevil.test', '/invites/a\n']) {
    assert.equal(safeReturnTo(invalid), '/home')
  }
})

test('돌아갈 목적지 쿠키를 서명·만료 처리하고 OIDC 상태와 연결한다', () => {
  const token = createReturnToCookie('/settlements/r-1', 'oidc-state', secret, 100)
  assert.equal(readReturnToCookie(token, 'oidc-state', secret, 101), '/settlements/r-1')
  assert.equal(readReturnToCookie(token, undefined, secret, 101), '/settlements/r-1')
  assert.equal(readReturnToCookie(token, 'wrong-state', secret, 101), '/home')
  assert.equal(readReturnToCookie(token, 'oidc-state', secret, 700), '/home')
  assert.equal(readReturnToCookie(`${token}x`, 'oidc-state', secret, 101), '/home')
  assert.equal(readReturnToCookie(undefined), '/home')
})
