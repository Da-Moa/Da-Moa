import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { runMigrations } from 'graphile-worker'

export const migrationFiles = ['001-auth-lifecycle.sql', '002-groups-settlement.sql', '003-round-cascade-constraints.sql', '004-round-currency.sql', '005-round-creator.sql', '006-receipt-avif.sql', '007-settlement-check.sql', '008-transfer-receipt-check.sql', '009-openbanking.sql', '010-custom-expense-shares.sql', '011-formatted-account-number.sql', '012-correct-account-number-format.sql', '013-bank-display-groups.sql', '014-legacy-receipt-storage.sql', '015-expanded-round-currencies.sql', '016-expense-currencies.sql', '017-receipt-upload-queue.sql']

// Accepts a connected PostgreSQL client; tests can use their isolated database.
export async function applyMigrations(client) {
  const pgPool = new Pool({ ...client.connectionParameters, password: client.connectionParameters.password, max: 1 })
  pgPool.on('error', error => console.error('Worker migration pool error', error))
  pgPool.on('connect', connection => connection.on('error', error => console.error('Worker migration connection error', error)))
  try { await runMigrations({ pgPool }) } finally { await pgPool.end() }
  await client.query('BEGIN')
  try {
    await client.query("SET LOCAL lock_timeout = '15s'")
    await client.query("SET LOCAL statement_timeout = '60s'")
    await client.query('SELECT pg_advisory_xact_lock(1684106607)')
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::BIGINT
      )
    `)
    for (const version of migrationFiles) {
      const applied = await client.query('SELECT version FROM schema_migrations WHERE version = $1', [version])
      if (applied.rows.length) continue
      const sql = await readFile(new URL(`./migrations/${version}`, import.meta.url), 'utf8')
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [version])
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  }
}
