import assert from 'node:assert/strict'
import { Socket } from 'node:net'
import test from 'node:test'
import { createDatabaseClient, withReadTransaction, withWriteTransaction, type Database } from './db'
import { getDatabasePool } from './db-client.mjs'

test('Docker PostgreSQL service uses a direct TCP socket', () => {
  const client = createDatabaseClient('postgresql://da_moa:secret@postgres:5432/da_moa')
  assert.ok((client as unknown as { connection: { stream: unknown } }).connection.stream instanceof Socket)
})

test('pooled transactions release connections and discard them when rollback fails', async t => {
  const previous = process.env.DATABASE_URL
  const url = 'postgresql://test:test@localhost/pool_unit_test'
  process.env.DATABASE_URL = url
  const pool = getDatabasePool(url)
  t.after(async () => {
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
    await pool.end()
  })
  assert.equal(getDatabasePool(url), pool)
  const statements: string[] = []
  const failure = new Error('transaction failed')
  let failCommit = false
  let failRollback = false
  const release = t.mock.fn()
  const client = {
    query: async (sql: string) => {
      statements.push(sql)
      if (sql === 'COMMIT' && failCommit || sql === 'ROLLBACK' && failRollback) throw failure
      return { rows: [] }
    },
    release,
  } as unknown as Database
  const connect = t.mock.method(pool, 'connect', async () => client)

  assert.equal(await withReadTransaction(async connection => {
    assert.equal(connection, client)
    return 42
  }), 42)
  assert.deepEqual(statements, ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    "SET LOCAL statement_timeout = '15s'", "SET LOCAL lock_timeout = '10s'", 'COMMIT'])
  assert.deepEqual(release.mock.calls.at(-1)!.arguments, [false])

  statements.length = 0
  await assert.rejects(withWriteTransaction(async () => { throw failure }), error => error === failure)
  assert.deepEqual(statements, ['BEGIN', "SET LOCAL statement_timeout = '15s'",
    "SET LOCAL lock_timeout = '10s'", 'SELECT pg_advisory_xact_lock(1684106607)', 'ROLLBACK'])
  assert.deepEqual(release.mock.calls.at(-1)!.arguments, [false])

  failCommit = true
  await assert.rejects(withReadTransaction(async () => 42), error => error === failure)
  assert.deepEqual(statements.slice(-2), ['COMMIT', 'ROLLBACK'])
  assert.deepEqual(release.mock.calls.at(-1)!.arguments, [false])

  failRollback = true
  await assert.rejects(withReadTransaction(async () => { throw failure }), error => error === failure)
  assert.deepEqual(release.mock.calls.at(-1)!.arguments, [true])
  assert.equal(release.mock.callCount(), 4)

  connect.mock.mockImplementation(async () => { throw failure })
  await assert.rejects(withReadTransaction(async () => assert.fail('must not execute')), error => error === failure)
  assert.equal(release.mock.callCount(), 4)
})
