import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { readAccessToken } from '../src/lib/auth.ts'
import { completeOnboarding, signInKakao, updateBankAccount } from '../src/lib/auth-store.ts'
import { getAccount } from '../src/lib/authorization.ts'
import { createDatabaseClient } from '../src/lib/db.ts'
import { applyMigrations } from './migrations.mjs'

const testUrl = process.env.TEST_DATABASE_URL
if (!testUrl || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(testUrl).hostname) || !new URL(testUrl).pathname.toLowerCase().includes('test')) {
  throw new Error('TEST_DATABASE_URL must name an isolated local test database')
}
process.env.DATABASE_URL = testUrl
process.env.AUTH_JWT_SECRET ||= 'integration-only-not-a-production-secret-0123456789'

test('account writes and migrations preserve digits with corrected layouts and allow unknown formats', async () => {
  const client = createDatabaseClient(testUrl)
  await client.connect()
  try {
    await applyMigrations(client)
    const signup = await signInKakao(`formatted-account:${randomUUID()}`, { displayName: '계좌 검증', email: null, profileImageUrl: null })
    const onboardingAccess = readAccessToken(signup.accessToken)
    assert.ok(onboardingAccess)
    const session = await completeOnboarding(onboardingAccess, {
      bankCode: '092', accountNumber: '9999-9999', accountHolder: '계좌 검증', expectedBankVersion: 0,
    })
    const access = readAccessToken(session.accessToken)
    assert.ok(access)
    const saved = await client.query('SELECT account_number, account_number_formatted FROM users WHERE id=$1', [session.userId])
    assert.deepEqual(saved.rows[0], { account_number: '99999999', account_number_formatted: '99999999' })
    await updateBankAccount(access, randomUUID(), {
      bankCode: '090', accountNumber: '3333123456789', accountHolder: '계좌 검증', expectedBankVersion: 1,
    })
    assert.equal((await getAccount(access)).formattedAccountNumber, '3333-12-3456789')
    const correction = await readFile(new URL('./migrations/013-bank-display-groups.sql', import.meta.url), 'utf8')
    let version = 2
    for (const [bankCode, number, previous, expected] of [
      ['004', '94160201358511', '9416-02-0135851-1', '941602-01-358511'],
      ['089', '100150532064', '1001-5053-2064', '100-150-532064'],
      ['003', '98216737701010', '982-167377-01-01-0', '982-167377-01-010'],
      ['004', '35060104400218', '3506-01-0440021-8', '350601-04-400218'],
      ['090', '99999999', '9999-9999', '99999999'],
    ]) {
      await updateBankAccount(access, randomUUID(), {
        bankCode, accountNumber: previous, accountHolder: '계좌 검증', expectedBankVersion: version++,
      })
      const account = await getAccount(access)
      assert.equal(account.accountNumber, number)
      assert.equal(account.formattedAccountNumber, expected)
      if (bankCode !== '090') {
        await client.query('UPDATE users SET account_number_formatted=$2 WHERE id=$1', [session.userId, previous])
        await client.query(correction)
        assert.deepEqual(await getAccount(access), account)
      }
    }
  } finally {
    await client.end()
  }
})
