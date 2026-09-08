import assert from 'node:assert/strict'
import test from 'node:test'
import { TEST_ACCOUNTS, testAccountForKey, testLoginGuard } from './test-accounts.ts'

test('test accounts are fixed, distinct, allowlisted, and unavailable outside local non-production', () => {
  assert.equal(TEST_ACCOUNTS.length, 3)
  for (const field of ['key', 'id', 'providerSubject', 'displayName', 'bankName', 'accountNumber'] as const) {
    assert.equal(new Set(TEST_ACCOUNTS.map(account => account[field])).size, 3)
  }
  assert.equal(testAccountForKey('member-a')?.displayName, '테스트 민지')
  assert.equal(testAccountForKey('unknown'), undefined)
  assert.equal(testLoginGuard('development', 'localhost', 'http://localhost:3000', 'http://localhost:3000'), null)
  assert.equal(testLoginGuard('development', 'localhost', 'https://evil.test', 'http://localhost:3000'), 403)
  assert.equal(testLoginGuard('development', 'dev.example.com', 'https://dev.example.com', 'https://dev.example.com'), 404)
  assert.equal(testLoginGuard('production', 'localhost', 'http://localhost:3000', 'http://localhost:3000'), 404)
})
