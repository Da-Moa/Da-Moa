import { readFile } from 'node:fs/promises'

export const migrationFiles = ['001-auth-lifecycle.sql', '002-groups-settlement.sql', '003-round-cascade-constraints.sql', '004-round-currency.sql', '005-round-creator.sql']

// Accepts a connected PostgreSQL client; tests can use their isolated database.
export async function applyMigrations(client) {
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
