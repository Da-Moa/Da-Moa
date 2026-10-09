import assert from 'node:assert/strict'
import test from 'node:test'
import { TEST_ACCOUNTS, testAccountForKey, testLoginGuard } from '../../../shared/testAccounts.ts'

test('test accounts are fixed, distinct, allowlisted, and unavailable outside local non-production', () => {
  assert.equal(TEST_ACCOUNTS.length, 5)
  for (const field of ['key', 'id', 'providerSubject', 'displayName', 'bankName', 'accountNumber'] as const) {
    assert.equal(new Set(TEST_ACCOUNTS.map(account => account[field])).size, TEST_ACCOUNTS.length)
  }
  assert.equal(testAccountForKey('member-a')?.displayName, '테스트 민지')
  assert.equal(testAccountForKey('member-e')?.displayName, '테스트 현우')
  assert.equal(testAccountForKey('unknown'), undefined)
  assert.equal(testLoginGuard('development', 'localhost', 'http://localhost:3000', 'http://localhost:3000'), null)
  assert.equal(testLoginGuard('development', 'localhost', 'https://evil.test', 'http://localhost:3000'), 403)
  assert.equal(testLoginGuard('development', 'dev.example.com', 'https://dev.example.com', 'https://dev.example.com'), 404)
  assert.equal(testLoginGuard('production', 'localhost', 'http://localhost:3000', 'http://localhost:3000'), 404)
})

test('test login accepts the development server private IPv4 address with a matching origin', () => {
  for (const hostname of ['192.168.219.102', '10.0.0.2', '172.16.0.2', '172.31.0.2']) {
    const origin = `http://${hostname}:3000`
    assert.equal(testLoginGuard('development', hostname, origin, origin, [hostname]), null)
    assert.equal(testLoginGuard('development', hostname, 'http://evil.test', origin, [hostname]), 403)
    assert.equal(testLoginGuard('development', hostname, null, origin, [hostname]), 403)
    assert.equal(testLoginGuard('production', hostname, origin, origin, [hostname]), 404)
  }
  for (const hostname of ['192.168.219.103', '172.15.0.2', '172.32.0.2', '203.0.113.2', 'dev.example.com']) {
    const origin = `http://${hostname}:3000`
    assert.equal(testLoginGuard('development', hostname, origin, origin, ['192.168.219.102', '172.15.0.2', '172.32.0.2', '203.0.113.2', 'dev.example.com']), 404)
  }
})
