import assert from 'node:assert/strict'
import { channel } from 'node:diagnostics_channel'
import test from 'node:test'
import { withReadTransaction, withWriteTransaction } from '../src/lib/db.ts'
import { getDatabasePool } from '../src/lib/db-client.mjs'

const testUrl = process.env.TEST_DATABASE_URL
if (!testUrl || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(testUrl).hostname)
  || !new URL(testUrl).pathname.toLowerCase().includes('test')) {
  throw new Error('TEST_DATABASE_URL must name an isolated local test database')
}
process.env.DATABASE_URL = testUrl

test('PostgreSQL pool reuses connections, rolls back safely, and isolates concurrent transactions', async t => {
  const pool = getDatabasePool(testUrl)
  t.after(() => pool.end())
  let queries = 0
  const countQuery = () => { queries++ }
  channel('da-moa.db.query').subscribe(countQuery)
  t.after(() => channel('da-moa.db.query').unsubscribe(countQuery))
  const backend = () => withReadTransaction(async client =>
    (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
  const pid = await backend()
  assert.equal(await backend(), pid)
  assert.equal(queries, 10, 'reused connections must count each query exactly once')
  assert.equal(pool.totalCount, 1)
  assert.equal(pool.idleCount, 1)

  const failure = new Error('rollback probe')
  await assert.rejects(withWriteTransaction(async client => {
    await client.query('CREATE TEMP TABLE pool_rollback_probe (id integer)')
    await client.query('INSERT INTO pool_rollback_probe VALUES (1)')
    throw failure
  }), error => error === failure)
  const state = await withReadTransaction(async client =>
    (await client.query("SELECT pg_backend_pid() AS pid, to_regclass('pg_temp.pool_rollback_probe') AS probe")).rows[0])
  assert.equal(state.pid, pid)
  assert.equal(state.probe, null)
  const client = await pool.connect()
  try {
    assert.equal((await client.query('SHOW statement_timeout')).rows[0].statement_timeout, '0')
    assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'off')
  } finally { client.release() }

  let arrived = 0
  let resume!: () => void
  const ready = new Promise<void>(resolve => { resume = resolve })
  const concurrent = () => withReadTransaction(async client => {
    if (++arrived === 2) resume()
    await ready
    assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on')
    return (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
  })
  const pids = await Promise.all([concurrent(), concurrent()])
  assert.notEqual(pids[0], pids[1])
  assert.equal(pool.totalCount, 2)
  assert.equal(pool.idleCount, 2)
})
