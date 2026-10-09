import assert from 'node:assert/strict'
import test from 'node:test'
import { PrismaService } from '../../global/database/prisma.service'
import { createDatabaseClient } from '../../global/database/db'
import { Socket } from 'node:net'

test('PostgreSQL uses TCP; Prisma transaction callbacks preserve lock ordering and failures', async t => {
  assert.ok((createDatabaseClient('postgresql://test:test@postgres/test') as unknown as { connection: { stream: unknown } }).connection.stream instanceof Socket)
  const service = new PrismaService(), statements: string[] = []
  const tx = { $queryRaw: async () => { statements.push('lock') } }
  const failure = new Error('rollback')
  const client = { $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
    statements.push('begin')
    try { const result = await work(tx); statements.push('commit'); return result }
    catch (error) { statements.push('rollback'); throw error }
  } }
  Object.defineProperty(service, 'client', { value: client })
  assert.equal(await service.withWriteTransaction(async connection => {
    assert.equal(connection.prisma, tx)
    statements.push('work'); return 42
  }, async () => { statements.push('account') }, async () => { statements.push('preflight') }), 42)
  assert.deepEqual(statements, ['preflight', 'begin', 'account', 'lock', 'work', 'commit'])
  statements.length = 0
  await assert.rejects(service.withWriteTransaction(async () => { throw failure }), error => error === failure)
  assert.deepEqual(statements, ['begin', 'lock', 'rollback'])
})
