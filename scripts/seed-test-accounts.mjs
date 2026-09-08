import assert from 'node:assert/strict'
import nextEnv from '@next/env'
import { createDatabaseClient } from '../src/lib/db.ts'
import { TEST_ACCOUNTS as accounts } from '../src/lib/test-accounts.ts'
import { applyMigrations } from './migrations.mjs'

nextEnv.loadEnvConfig(process.cwd())
const database = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
assert.ok(database, 'TEST_DATABASE_URL or DATABASE_URL is required')
const url = new URL(database)
const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
if (local) assert.ok(url.pathname.toLowerCase().includes('test'), 'Local test database name must include test')
else assert.equal(process.env.ALLOW_REMOTE_TEST_ACCOUNT_SEED, 'true', 'Set ALLOW_REMOTE_TEST_ACCOUNT_SEED=true to seed an explicit remote development database')

const client = createDatabaseClient(database)
let connected = false
let inTransaction = false
try {
  await client.connect()
  connected = true
  await applyMigrations(client)
  await client.query('BEGIN')
  inTransaction = true
  await client.query('SELECT pg_advisory_xact_lock(1684106607)')
  const now = 1_735_689_600
  for (const account of accounts) {
    await client.query(`
      INSERT INTO users(
        id, provider, provider_subject, display_name, email, profile_image_url,
        created_at, updated_at, deleted_at, onboarding_completed_at,
        bank_name, account_number, account_holder, bank_updated_at
      ) VALUES ($1, 'test', $2, $3, $4, NULL, $5, $5, NULL, $5, $6, $7, $8, $5)
      ON CONFLICT (provider, provider_subject) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        email = EXCLUDED.email,
        deleted_at = NULL,
        onboarding_completed_at = EXCLUDED.onboarding_completed_at,
        bank_name = EXCLUDED.bank_name,
        account_number = EXCLUDED.account_number,
        account_holder = EXCLUDED.account_holder,
        bank_updated_at = EXCLUDED.bank_updated_at,
        updated_at = EXCLUDED.updated_at
    `, [account.id, account.providerSubject, account.displayName, account.email, now, account.bankName, account.accountNumber, account.accountHolder])
  }
  const { rows } = await client.query(`
    SELECT id, provider_subject AS "providerSubject", display_name AS "displayName",
      email, bank_name AS "bankName", account_number AS "accountNumber", account_holder AS "accountHolder"
    FROM users WHERE provider = 'test' AND provider_subject = ANY($1::text[])
    ORDER BY provider_subject
  `, [accounts.map(account => account.providerSubject)])
  assert.deepEqual(rows, accounts.map(({ key: _, ...account }) => account))
  await client.query('COMMIT')
  inTransaction = false

  console.table(rows)
  console.info('테스트 계정 3개를 준비했습니다. 시드는 세션을 생성하지 않으며, 로컬 개발 로그인에서만 사용할 수 있습니다.')
} catch (error) {
  if (inTransaction) await client.query('ROLLBACK').catch(() => {})
  throw error
} finally {
  if (connected) await client.end()
}
