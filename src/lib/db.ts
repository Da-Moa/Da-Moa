import type { PoolClient } from 'pg'
import { getDatabasePool } from './db-client.mjs'
export { createDatabaseClient } from './db-client.mjs'

export type Database = PoolClient

function connectionString() {
  const value = process.env.DATABASE_URL || process.env.POSTGRES_URL
  if (!value) throw new Error('DATABASE_URL is required')
  return value
}

export async function withDatabaseConnection<T>(work: (client: Database, discardConnection: () => void) => Promise<T>): Promise<T> {
  const client = await getDatabasePool(connectionString()).connect()
  let discard = false
  try { return await work(client, () => { discard = true }) }
  finally { client.release(discard) }
}

export async function withWriteLock<T>(client: Database, discardConnection: () => void, work: () => Promise<T>): Promise<T> {
  // ponytail: share the existing global write lock; use group locks when all competing writes adopt them.
  try { await client.query('SELECT pg_advisory_lock(1684106607)') }
  catch (error) { discardConnection(); throw error }
  try { return await work() }
  finally {
    try {
      const { rows } = await client.query('SELECT pg_advisory_unlock(1684106607) AS unlocked')
      if (!rows[0]?.unlocked) throw new Error('Database write lock was not released')
    } catch (error) {
      discardConnection()
      throw error
    }
  }
}

async function transaction<T>(write: boolean, work: (client: Database) => Promise<T>, beforeLock?: (client: Database) => Promise<void>, beforeBegin?: (client: Database) => Promise<void>): Promise<T> {
  const client = await getDatabasePool(connectionString()).connect()
  let discard = false
  let begun = false
  try {
    await beforeBegin?.(client)
    begun = true
    await client.query(write ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await beforeLock?.(client)
    // ponytail: serialize writes initially; use ordered user/group/round locks when measured contention warrants it.
    if (write) await client.query('SELECT pg_advisory_xact_lock(1684106607)')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    if (begun) try { await client.query('ROLLBACK') } catch { discard = true /* A lost COMMIT response is resolved with the request key. */ }
    throw error
  } finally {
    client.release(discard)
  }
}

export function withWriteTransaction<T>(work: (client: Database) => Promise<T>, beforeLock?: (client: Database) => Promise<void>, beforeBegin?: (client: Database) => Promise<void>): Promise<T> {
  return transaction(true, work, beforeLock, beforeBegin)
}

export function withReadTransaction<T>(work: (client: Database) => Promise<T>): Promise<T> {
  return transaction(false, work)
}
