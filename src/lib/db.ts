import type { Client } from '@neondatabase/serverless'
import { createDatabaseClient } from './db-client.mjs'
export { createDatabaseClient } from './db-client.mjs'

export type Database = Client


function connectionString() {
  const value = process.env.DATABASE_URL || process.env.POSTGRES_URL
  if (!value) throw new Error('DATABASE_URL is required')
  return value
}

async function transaction<T>(write: boolean, work: (client: Client) => Promise<T>): Promise<T> {
  const client = createDatabaseClient(connectionString())
  try {
    await client.connect()
    await client.query(write ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '15s'")
    await client.query("SET LOCAL lock_timeout = '10s'")
    // ponytail: serialize writes initially; use ordered user/group/round locks when measured contention warrants it.
    if (write) await client.query('SELECT pg_advisory_xact_lock(1684106607)')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* A lost COMMIT response is resolved with the request key. */ }
    throw error
  } finally {
    try { await client.end() } catch (error) { console.error('Database client cleanup failed', error) }
  }
}

export function withWriteTransaction<T>(work: (client: Client) => Promise<T>): Promise<T> {
  return transaction(true, work)
}

export function withReadTransaction<T>(work: (client: Client) => Promise<T>): Promise<T> {
  return transaction(false, work)
}
