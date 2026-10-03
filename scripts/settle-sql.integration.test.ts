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
    const trace = async <T>(count: number, write: boolean | 'receipt' | 'session' | 'connection', work: () => Promise<T>) => {
      statements = []
      const result = await work()
      assert.equal(statements.length, count, statements.join('\n'))
      if (write === 'connection') {
        assert.ok(statements.every(sql => !/^(BEGIN|COMMIT|ROLLBACK|SET)\b|pg_advisory|FOR UPDATE|FOR SHARE/.test(sql)))
        if (count) assert.match(statements[0], /FROM users u WHERE u.id = \$1/)
        if (count === 2) assert.match(statements[1], /FROM rounds r JOIN groups g/)
      } else if (write === 'session') {
        assert.ok(statements.every(sql => !/^(BEGIN|COMMIT|ROLLBACK|SET)\b/.test(sql) && !/pg_advisory_xact_lock|FOR UPDATE|FOR SHARE|mutation_requests/.test(sql)))
        assert.equal(statements[0], 'SELECT pg_advisory_lock(1684106607)')
        assert.equal(statements.at(-1), 'SELECT pg_advisory_unlock(1684106607) AS unlocked')
      } else {
        assert.equal(statements[0], write === true ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        assert.equal(statements.at(-1), 'COMMIT')
        assert.equal(statements.some(sql => sql.includes('pg_advisory_xact_lock')), write !== false)
      }
      assert.ok(statements.every(sql => !/^SET\b/.test(sql) && !sql.includes('refresh_sessions')))
      return result
    }
    try {
      const createKey = uuidV7(), body = { name: '호출 수 검증', currency: 'KRW', participantIds: [a.userId, b.userId, c.userId] }
      const round = await trace(4, 'session', () => createRound(a, createKey, group.id, body))
      await trace(4, 'session', () => assert.rejects(createRound(a, createKey, group.id, body), (error: { code: string }) => error.code === 'round_already_exists'))
      assert.equal(round.id, createKey)
      await trace(4, 'session', () => assert.rejects(createRound(a, createKey.toUpperCase(), group.id, { ...body, name: '다른 제목' }), (error: { code: string }) => error.code === 'round_already_exists'))
      for (const [actor, ticket, input, expected, count] of [
        [null, '', {}, 'unauthorized', 2],
        [{ ...a, userId: randomUUID() }, '', {}, 'unauthorized', 3],
        [a, randomUUID(), body, 'invalid_request_key', 3],
        [a, '', body, 'invalid_request_key', 3],
        [a, uuidV7(), { ...body, name: '' }, 'invalid_input', 3],
        [a, uuidV7(), { ...body, currency: 'INVALID' }, 'unsupported_currency', 3],
        [a, uuidV7(), { ...body, participantIds: [a.userId] }, 'minimum_participants', 3],
        [a, uuidV7(), { ...body, participantIds: [a.userId, a.userId] }, 'invalid_participants', 3],
        [a, uuidV7(), { ...body, participantIds: [a.userId, randomUUID()] }, 'invalid_participants', 4],
      ] as const) await trace(count, 'session', () => assert.rejects(createRound(actor, ticket, group.id, input), (error: { code: string }) => error.code === expected))
      await trace(4, 'session', () => assert.rejects(createRound(a, uuidV7(), randomUUID(), body), (error: { code: string }) => error.code === 'not_found'))
      assert.equal((await db.query('SELECT 1 FROM mutation_requests WHERE request_key=$1', [createKey])).rowCount, 0)
      const concurrentKey = uuidV7()
      const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => createRound(b, concurrentKey, group.id, body)))
      assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1)
      assert.ok(outcomes.filter(result => result.status === 'rejected').every(result => result.reason.code === 'round_already_exists'))
      assert.equal((await db.query('SELECT COUNT(*)::int AS count FROM round_members WHERE round_id=$1', [concurrentKey])).rows[0].count, 3)
      const rejectedKey = uuidV7(), constraint = `round_create_test_${randomUUID().replaceAll('-', '')}`
      await db.query(`ALTER TABLE round_members ADD CONSTRAINT ${constraint} CHECK (round_id <> '${rejectedKey}') NOT VALID`)
      try {
        await trace(4, 'session', () => assert.rejects(createRound(a, rejectedKey, group.id, body), (error: { code: string; constraint: string }) => error.code === '23514' && error.constraint === constraint))
        assert.equal((await db.query('SELECT 1 FROM rounds WHERE id=$1', [rejectedKey])).rowCount, 0)
        assert.equal((await db.query('SELECT 1 FROM round_members WHERE round_id=$1', [rejectedKey])).rowCount, 0)
      } finally { await db.query(`ALTER TABLE round_members DROP CONSTRAINT ${constraint}`) }

      for (const groupId of [group.id, undefined]) {
        const first = await trace(2, 'connection', () => listRounds(a, new URLSearchParams({ limit: '1', status: 'active', q: body.name }), groupId))
        assert.equal(first.items.length, 1)
        assert.ok(first.nextCursor)
        const second = await trace(2, 'connection', () => listRounds(a, new URLSearchParams({ limit: '1', cursor: first.nextCursor! }), groupId))
        assert.equal(second.items.length, 1)
        assert.equal(second.nextCursor, null)
        assert.deepEqual(new Set([...first.items, ...second.items].map(item => item.id)), new Set([round.id, concurrentKey]))
        assert.deepEqual((await trace(2, 'connection', () => listRounds(a, new URLSearchParams({ q: '없는회차' }), groupId))).items, [])
        for (const [input, expected] of [
          [{ limit: '0' }, 'invalid_input'], [{ limit: '101' }, 'invalid_input'], [{ limit: '1.5' }, 'invalid_input'],
          [{ cursor: 'invalid' }, 'invalid_cursor'], [{ status: 'INVALID' }, 'invalid_input'], [{ q: '' }, 'invalid_input'],
        ] as const) {
          await trace(1, 'connection', () => assert.rejects(listRounds(a, new URLSearchParams(input), groupId), (error: { code: string }) => error.code === expected))
          await trace(1, 'connection', () => assert.rejects(listRounds({ ...a, userId: randomUUID() }, new URLSearchParams(input), groupId), (error: { code: string }) => error.code === 'unauthorized'))
        }
        await trace(0, 'connection', () => assert.rejects(listRounds(null, new URLSearchParams({ limit: '0' }), groupId), (error: { code: string }) => error.code === 'unauthorized'))
      }
      assert.deepEqual((await trace(2, 'connection', () => listRounds(a, new URLSearchParams(), randomUUID()))).items, [])
      const empty = await trace(2, 'connection', () => getRound(a, round.id, new URLSearchParams()))
      assert.deepEqual(empty.expenses, [])
      assert.deepEqual(empty.transfers, [])
      assert.equal(empty.totalMinor, '0')
      assert.equal(empty.balanceMinor, null)
      assert.equal(empty.memberCount, 3)
      assert.equal(empty.expensesNextCursor, null)
      for (const [input, expected] of [
        [{ limit: '0' }, 'invalid_input'], [{ limit: '101' }, 'invalid_input'], [{ cursor: 'invalid' }, 'invalid_cursor'],
      ] as const) {
        await trace(1, 'connection', () => assert.rejects(getRound(a, round.id, new URLSearchParams(input)), (error: { code: string }) => error.code === expected))
        await trace(1, 'connection', () => assert.rejects(getRound({ ...a, userId: randomUUID() }, round.id, new URLSearchParams(input)), (error: { code: string }) => error.code === 'unauthorized'))
      }
      await trace(0, 'connection', () => assert.rejects(getRound(null, round.id, new URLSearchParams({ limit: '0' })), (error: { code: string }) => error.code === 'unauthorized'))
      await trace(2, 'connection', () => assert.rejects(getRound(a, randomUUID(), new URLSearchParams()), (error: { code: string }) => error.code === 'not_found'))
      const nonParticipant = await member('비참여 모임 멤버')
      await acceptInvite(nonParticipant, key(), invite.sharePath!.split('/').at(-1)!)
      await trace(2, 'connection', () => assert.rejects(getRound(nonParticipant, round.id, new URLSearchParams()), (error: { code: string }) => error.code === 'not_found'))
      let version = 1
      const expenseKey = key(), expenseBody = { description: '지출', amount: '100', payerId: b.userId, splitMode: 'ALL', expectedVersion: version }
      const expense = await trace(13, true, () => saveExpense(a, expenseKey, round.id, expenseBody))
      version = expense.version!
      await trace(5, true, () => saveExpense(a, expenseKey, round.id, expenseBody))
      const updated = await trace(14, true, () => saveExpense(a, key(), round.id, { amount: '101', expectedVersion: version }, expense.id))
      version = updated.version!
      const participantExpense = await trace(14, true, () => saveExpense(b, key(), round.id, { ...expenseBody, expectedVersion: version }))
      version = participantExpense.version!
      const firstPage = await trace(2, 'connection', () => getRound(a, round.id, new URLSearchParams({ limit: '1' })))
      const secondPage = await trace(2, 'connection', () => getRound(a, round.id, new URLSearchParams({ limit: '1', cursor: firstPage.expensesNextCursor! })))
      assert.equal(firstPage.totalMinor, '201')
      assert.equal(firstPage.pendingRemainderMinor, '3')
      assert.deepEqual(secondPage.transfers, firstPage.transfers)
      assert.equal(secondPage.expensesNextCursor, null)
      assert.notEqual(firstPage.expenses[0].id, secondPage.expenses[0].id)
      const pastEnd = Buffer.from(JSON.stringify({ createdAt: '0', id: 'end' })).toString('base64url')
      const emptyPage = await trace(2, 'connection', () => getRound(a, round.id, new URLSearchParams({ cursor: pastEnd })))
      assert.deepEqual(emptyPage.expenses, [])
      assert.deepEqual(emptyPage.transfers, firstPage.transfers)
      assert.equal(emptyPage.totalMinor, firstPage.totalMinor)
      assert.equal(emptyPage.pendingRemainderMinor, firstPage.pendingRemainderMinor)
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
      await trace(2, 'connection', () => getRound(a, round.id, new URLSearchParams()))
      const settlement = await trace(8, false, () => getSettlement(a, round.id))
      assert.equal(settlement.outgoing.length, 1)
      assert.ok(settlement.outgoing[0].account)
      const checkKey = key(), checkBody = { checked: true, senderId: a.userId, expectedVersion: version }
      await trace(8, true, () => setSettlementCheck(b, checkKey, round.id, checkBody))
      await trace(5, true, () => setSettlementCheck(b, checkKey, round.id, checkBody))
      await command('complete', 10)
      const cancelled = await trace(4, 'session', () => createRound(a, uuidV7(), group.id, { ...body, participantIds: [a.userId, b.userId] }))
      const historical = await trace(2, 'connection', () => listRounds(c, new URLSearchParams(), group.id))
      assert.ok(historical.items.some(item => item.id === round.id), 'excluded participants retain round history')
      assert.ok(historical.items.every(item => item.id !== cancelled.id), 'group membership alone does not expose a round')
      await trace(9, true, () => roundCommand(a, key(), cancelled.id, 'cancel', { expectedVersion: 1 }))
      const even = await trace(4, 'session', () => createRound(a, uuidV7(), group.id, { ...body, participantIds: [a.userId, b.userId] }))
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
