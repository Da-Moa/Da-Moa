import assert from 'node:assert/strict'
import { Socket } from 'node:net'
import test from 'node:test'
import { createDatabaseClient } from './db'

test('Docker PostgreSQL service uses a direct TCP socket', () => {
  const client = createDatabaseClient('postgresql://da_moa:secret@postgres:5432/da_moa')
  assert.ok((client as unknown as { connection: { stream: unknown } }).connection.stream instanceof Socket)
})
