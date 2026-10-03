import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import sharp from 'sharp'
import { readAccessToken } from '../src/lib/auth.ts'
import { signInKakao } from '../src/Global/Auth/Backend/index.ts'
import { acceptInvite, createGroup, createInvite } from '../src/Domain/Group/Backend/index.ts'
import { addReceipt, checkExclusion, createRound, deleteExpense, excludeMember, getReceipt, getRound, getSettlement, listRounds, removeReceipt, roundCommand, saveExpense, setSettlementCheck } from '../src/Domain/Settle/Backend/index.ts'
import { createDatabaseClient } from '../src/lib/db.ts'
import { uuidV7 } from '../src/lib/uuid.ts'
import { completeTestOnboarding } from './bank-test-support.ts'
import { applyMigrations } from './migrations.mjs'

const database = process.env.TEST_DATABASE_URL
if (!database || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(database).hostname) || !new URL(database).pathname.toLowerCase().includes('test')) throw new Error('TEST_DATABASE_URL must name an isolated local test database')
process.env.DATABASE_URL = database
process.env.AUTH_JWT_SECRET ||= 'isolated-settle-test-secret-at-least-32-bytes'
const key = () => randomUUID()

test('Settle public APIs preserve actual SQL counts, transaction order, branches and replay', async t => {
  const db = createDatabaseClient(database)
  await db.connect()
  const previous = process.env.DB_QUERY_LOG
  try {
    await applyMigrations(db)
    const member = async (name: string) => {
      const onboarding = await signInKakao(`settle-sql:${key()}`, { displayName: name, email: null, profileImageUrl: null })
      return readAccessToken((await completeTestOnboarding(readAccessToken(onboarding.accessToken), { bankName: '검증 은행', accountNumber: '12340312345678', accountHolder: name })).accessToken)!
    }
    const a = await member('회차 생성자'), b = await member('수취인'), c = await member('제외 대상')
    const group = await createGroup(a, uuidV7(), { name: 'Settle SQL 검증' })
    const invite = await createInvite(a, key(), group.id, {})
    for (const actor of [b, c]) await acceptInvite(actor, key(), invite.sharePath!.split('/').at(-1)!)
    process.env.DB_QUERY_LOG = 'true'
    let statements: string[] = []
    const logger = t.mock.method(console, 'info', (message: string) => { statements.push(message.replace(/^SQL:\s*/, '').replace(/\s+/g, ' ').trim()) })
    const trace = async <T>(count: number, write: boolean | 'receipt', work: () => Promise<T>) => {
      statements = []
      const result = await work()
      assert.equal(statements.length, count, statements.join('\n'))
      assert.equal(statements[0], write === true ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      assert.equal(statements.at(-1), 'COMMIT')
      assert.equal(statements.some(sql => sql.includes('pg_advisory_xact_lock')), write !== false)
      assert.ok(statements.every(sql => !/^SET\b/.test(sql) && !sql.includes('refresh_sessions')))
      return result
    }
    try {
      const createKey = key(), body = { name: '호출 수 검증', currency: 'KRW', participantIds: [a.userId, b.userId, c.userId] }
      const round = await trace(12, true, () => createRound(a, createKey, group.id, body))
      await trace(5, true, () => createRound(a, createKey, group.id, body))
      await trace(4, false, () => listRounds(a, new URLSearchParams(), group.id))
      await trace(4, false, () => listRounds(a, new URLSearchParams({ q: '없는회차' })))
      await trace(10, false, () => getRound(a, round.id, new URLSearchParams()))
      let version = 1
      const expenseKey = key(), expenseBody = { description: '지출', amount: '100', payerId: b.userId, splitMode: 'ALL', expectedVersion: version }
      const expense = await trace(13, true, () => saveExpense(a, expenseKey, round.id, expenseBody))
      version = expense.version!
      await trace(5, true, () => saveExpense(a, expenseKey, round.id, expenseBody))
      const updated = await trace(14, true, () => saveExpense(a, key(), round.id, { amount: '101', expectedVersion: version }, expense.id))
      version = updated.version!
      const participantExpense = await trace(14, true, () => saveExpense(b, key(), round.id, { ...expenseBody, expectedVersion: version }))
      version = participantExpense.version!
      await trace(11, false, () => getRound(a, round.id, new URLSearchParams({ limit: '1' })))
      const deleted = await trace(12, true, () => deleteExpense(b, key(), round.id, participantExpense.id, { expectedVersion: version }))
      version = deleted.version!
      const receiptKey = key(), receiptVersion = version
      const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } }).png().toBuffer()
      const receipt = await trace(16, 'receipt', () => addReceipt(a, receiptKey, round.id, expense.id, receiptVersion, bytes, 'image/png'))
      version = receipt.version!
      await trace(4, false, () => addReceipt(a, receiptKey, round.id, expense.id, receiptVersion, bytes, 'image/png'))
      const stored = await trace(4, false, () => getReceipt(b, receipt.id))
      assert.equal(stored.mimeType, 'image/avif')
      const removed = await trace(10, true, () => removeReceipt(a, key(), round.id, expense.id, receipt.id, { expectedVersion: version }))
      version = removed.version!
      assert.equal((await trace(6, false, () => checkExclusion(a, round.id, c.userId))).allowed, true)
      const excluded = await trace(12, true, () => excludeMember(a, key(), round.id, c.userId, { expectedVersion: version }))
      version = excluded.version!
      await trace(5, false, () => getSettlement(a, round.id))
      const command = async (action: string, count: number) => {
        const result = await trace(count, true, () => roundCommand(a, key(), round.id, action, { expectedVersion: version }))
        version = result.version!
      }
      await command('confirm', 12)
      await command('reopen', 10)
      await command('confirm', 12)
      await command('send', 12)
      // One expense: two shares + three historical members' balances + one transfer.
      await command('draw', 17)
      await command('draw', 7)
      await trace(11, false, () => getRound(a, round.id, new URLSearchParams()))
      const settlement = await trace(8, false, () => getSettlement(a, round.id))
      assert.equal(settlement.outgoing.length, 1)
      assert.ok(settlement.outgoing[0].account)
      const checkKey = key(), checkBody = { checked: true, senderId: a.userId, expectedVersion: version }
      await trace(8, true, () => setSettlementCheck(b, checkKey, round.id, checkBody))
      await trace(5, true, () => setSettlementCheck(b, checkKey, round.id, checkBody))
      await command('complete', 10)
      const cancelled = await trace(11, true, () => createRound(a, key(), group.id, { ...body, participantIds: [a.userId, b.userId] }))
      await trace(9, true, () => roundCommand(a, key(), cancelled.id, 'cancel', { expectedVersion: 1 }))
      const even = await trace(11, true, () => createRound(a, key(), group.id, { ...body, participantIds: [a.userId, b.userId] }))
      let evenVersion = (await trace(13, true, () => saveExpense(a, key(), even.id, { ...expenseBody, amount: '100', expectedVersion: 1 }))).version!
      evenVersion = (await trace(12, true, () => roundCommand(a, key(), even.id, 'confirm', { expectedVersion: evenVersion }))).version!
      // Two shares + two balances + one transfer, finalized directly by send.
      evenVersion = (await trace(20, true, () => roundCommand(a, key(), even.id, 'send', { expectedVersion: evenVersion }))).version!
      await trace(9, true, () => roundCommand(a, key(), even.id, 'force-complete', { expectedVersion: evenVersion }))
      statements = []
      await assert.rejects(saveExpense(a, key(), even.id, { ...expenseBody, expectedVersion: evenVersion }), (error: { code: string }) => error.code === 'invalid_round_state')
      assert.equal(statements.length, 6)
      assert.equal(statements.at(-1), 'ROLLBACK')
    } finally { logger.mock.restore() }
  } finally {
    if (previous === undefined) delete process.env.DB_QUERY_LOG
    else process.env.DB_QUERY_LOG = previous
    await db.end()
  }
})
