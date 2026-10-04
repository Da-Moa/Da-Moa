import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import sharp from 'sharp'
import { DeleteObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
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
    const trace = async <T>(count: number, write: boolean | 'receipt' | 'receipt-read' | 'session' | 'connection' | 'cancel' | 'expense' | 'patch' | 'delete' | 'exclude' | 'confirm' | 'reopen' | 'draw' | 'settlement' | 'check' | 'complete' | 'force-complete', work: () => Promise<T>) => {
      statements = []
      const result = await work()
      assert.equal(statements.length, count, statements.join('\n'))
      if (write === 'receipt-read') {
        assert.ok(statements.every(sql => !/^(BEGIN|COMMIT|ROLLBACK|SET)\b|pg_advisory|FOR UPDATE|FOR SHARE/.test(sql)))
        assert.match(statements[0], /FROM users u WHERE u.id = \$1/)
        assert.match(statements[1], /FROM expense_receipts rc JOIN expenses e.*JOIN rounds r.*JOIN round_members viewer/)
      } else if (write === 'receipt') {
        assert.ok(statements.every(sql => !/^(BEGIN|COMMIT|ROLLBACK|SET)\b|pg_advisory|FOR UPDATE|FOR SHARE/.test(sql)))
        if (count) assert.match(statements[0], /FROM users u WHERE u.id = \$1/)
        if (count > 1) assert.match(statements[1], /UPDATE rounds.*INSERT INTO expense_receipts.*INSERT INTO mutation_requests/)
      } else if (write === 'force-complete') {
        assert.ok(statements.every(sql => !/^(BEGIN|COMMIT|ROLLBACK|SET)\b|pg_advisory|FOR UPDATE|FOR SHARE/.test(sql)))
        if (count) assert.match(statements[0], /FROM users u WHERE u.id = \$1/)
        if (count > 1) assert.match(statements[1], /DISTINCT receiver_id.*received_at IS NULL.*AS pending_user_ids.*AS user_ids.*operation = 'round.force-complete'/)
        if (count === 3) {
          assert.match(statements[2], /UPDATE rounds.*status = 'COMPLETED'.*version = version \+ 1.*status = 'LOCKED'.*finalized_at IS NOT NULL.*version = \$5.*INSERT INTO mutation_requests/)
          assert.doesNotMatch(statements[2], /UPDATE settlement_transfers/)
        }
      } else if (write === 'complete') {
        assert.ok(statements.every(sql => !/^(BEGIN|COMMIT|ROLLBACK|SET)\b|pg_advisory|FOR UPDATE|FOR SHARE/.test(sql)))
        if (count) assert.match(statements[0], /FROM users u WHERE u.id = \$1/)
        if (count === 2) {
          assert.match(statements[1], /received_at IS NULL.*AS pending_count.*AS user_ids.*operation = 'round.complete'/)
          assert.match(statements[1], /UPDATE rounds.*status = 'LOCKED'.*version = \$5.*NOT EXISTS \( SELECT 1 FROM settlement_transfers WHERE round_id = \$1 AND received_at IS NULL \).*INSERT INTO mutation_requests/)
        }
      } else if (write === 'check') {
        assert.ok(statements.every(sql => !/^(BEGIN|COMMIT|ROLLBACK|SET)\b|pg_advisory|FOR UPDATE|FOR SHARE|mutation_requests/.test(sql)))
        if (count) assert.match(statements[0], /FROM users u WHERE u.id = \$1/)
        if (count > 1) assert.match(statements[1], /t.receiver_id = \$2.*AS incoming.*AS user_ids.*JOIN round_members viewer/)
        if (count === 3) assert.match(statements[2], /UPDATE settlement_transfers.*receiver_id = \$2.*received_at IS NOT NULL.*status = 'LOCKED'.*version = \$6/)
      } else if (write === 'settlement') {
        assert.ok(statements.every(sql => !/^(BEGIN|COMMIT|ROLLBACK|SET)\b|pg_advisory|FOR UPDATE|FOR SHARE/.test(sql)))
        if (count) assert.match(statements[0], /FROM users u WHERE u.id = \$1/)
        if (count === 2) {
          assert.match(statements[1], /AS confirmations.*AS outgoing.*AS incoming.*FROM rounds r JOIN groups g.*JOIN round_members viewer.*LEFT JOIN settlement_balances/)
          assert.match(statements[1], /t.sender_id = \$2.*t.received_at IS NULL.*t.receiver_id = \$2/)
        }
      } else if (write === 'draw') {
        assert.ok(statements.every(sql => !/^(BEGIN|COMMIT|ROLLBACK|SET)\b|pg_advisory/.test(sql)))
        if (count) assert.match(statements[0], /FROM users u WHERE u.id = \$1/)
        if (count > 1) assert.match(statements[1], /FROM rounds r JOIN round_members viewer.*operation = 'round.draw'/)
        if (count === 3) assert.match(statements[2], /FOR UPDATE OF r.*INSERT INTO mutation_requests.*UPDATE rounds.*UPDATE expense_shares.*INSERT INTO settlement_balances.*INSERT INTO settlement_transfers/)
      } else if (write === 'reopen') {
        assert.ok(statements.every(sql => !/^(BEGIN|COMMIT|ROLLBACK|SET)\b|pg_advisory|FOR UPDATE|FOR SHARE|mutation_requests/.test(sql)))
        if (count) assert.match(statements[0], /FROM users u WHERE u.id = \$1/)
        if (count > 1) assert.match(statements[1], /FROM rounds r JOIN groups g.*JOIN round_members m/)
        if (count === 3) assert.match(statements[2], /UPDATE rounds.*status = 'CONFIRMED'.*version = \$3.*UPDATE expenses/)
      } else if (write === 'exclude') {
        assert.ok(statements.every(sql => !/^(BEGIN|COMMIT|ROLLBACK|SET)\b|pg_advisory|FOR UPDATE|FOR SHARE|mutation_requests/.test(sql)))
        if (count) assert.match(statements[0], /FROM users u WHERE u.id = \$1/)
        if (count > 1) assert.match(statements[1], /FROM rounds r JOIN groups g.*LEFT JOIN round_members m/)
        if (count === 3) assert.match(statements[2], /UPDATE rounds.*UPDATE round_members.*DELETE FROM expense_shares/)
      } else if (write === 'delete') {
        assert.equal(statements[0], 'BEGIN')
        if (count > 2) assert.match(statements[1], /FROM users u WHERE u.id = \$1/)
        if (count > 3) assert.match(statements[2], /LEFT JOIN expenses.*operation = 'expense.delete'/)
        if (count >= 5) assert.equal(statements[3], 'SELECT pg_advisory_xact_lock(1684106607)')
        if (count === 6) assert.match(statements[4], /UPDATE rounds.*DELETE FROM expenses.*INSERT INTO mutation_requests/)
        assert.ok(['COMMIT', 'ROLLBACK'].includes(statements.at(-1)!))
        assert.ok(statements.every(sql => !sql.includes('pg_advisory_unlock')))
      } else if (write === 'patch') {
        assert.ok(statements.every(sql => !/^(BEGIN|COMMIT|ROLLBACK|SET)\b|pg_advisory_xact_lock|FOR UPDATE|FOR SHARE/.test(sql)))
        if (count) assert.match(statements[0], /FROM users u WHERE u.id = \$1/)
        if (count > 1) assert.match(statements[1], /FROM rounds r JOIN round_members viewer.*LEFT JOIN expenses/)
        if (count >= 5) {
          assert.equal(statements[2], 'SELECT pg_advisory_lock(1684106607)')
          assert.match(statements[3], /UPDATE rounds.*version = \$13.*UPDATE expenses.*DELETE FROM expense_shares.*INSERT INTO expense_shares.*INSERT INTO mutation_requests/)
          assert.equal(statements.at(-1), 'SELECT pg_advisory_unlock(1684106607) AS unlocked')
        }
      } else if (write === 'confirm') {
        if (count) assert.match(statements[0], /FROM users u WHERE u.id = \$1/)
        if (count > 1) {
          assert.equal(statements[1], 'BEGIN')
          assert.match(statements[2], /FROM rounds r JOIN round_members viewer.*operation = 'round.confirm'/)
          if (count >= 5) assert.equal(statements[3], 'SELECT pg_advisory_xact_lock(1684106607)')
          if (count === 6) assert.match(statements[4], /UPDATE rounds.*UPDATE expenses.*INSERT INTO mutation_requests/)
          assert.ok(['COMMIT', 'ROLLBACK'].includes(statements.at(-1)!))
        }
        assert.ok(statements.every(sql => !sql.includes('pg_advisory_unlock')))
      } else if (write === 'expense') {
        if (count) assert.match(statements[0], /FROM users u WHERE u.id = \$1/)
        if (count > 1) {
          assert.equal(statements[1], 'BEGIN')
          assert.equal(statements[2], 'SELECT pg_advisory_xact_lock(1684106607)')
          assert.match(statements[3], /INSERT INTO expenses/)
          if (count === 6) assert.match(statements[4], /INSERT INTO expense_shares.*UPDATE rounds.*INSERT INTO mutation_requests/)
          assert.ok(['COMMIT', 'ROLLBACK'].includes(statements.at(-1)!))
        }
        assert.ok(statements.every(sql => !sql.includes('pg_advisory_unlock')))
      } else if (write === 'cancel') {
        assert.equal(statements[0], 'BEGIN')
        assert.match(statements[1], /FROM users u WHERE u.id = \$1/)
        assert.equal(statements[2], 'SELECT pg_advisory_xact_lock(1684106607)')
        assert.match(statements[3], /EXISTS.*FROM expenses/)
        assert.ok(['COMMIT', 'ROLLBACK'].includes(statements.at(-1)!))
        assert.ok(statements.every(sql => !sql.includes('pg_advisory_unlock')))
      } else if (write === 'connection') {
        assert.ok(statements.every(sql => !/^(BEGIN|COMMIT|ROLLBACK|SET)\b|pg_advisory|FOR UPDATE|FOR SHARE/.test(sql)))
        if (count) assert.match(statements[0], /FROM users u WHERE u.id = \$1/)
        if (count >= 2) assert.match(statements[1], /FROM rounds r JOIN groups g/)
        if (count === 3) assert.match(statements[2], /SELECT m.excluded_at.*jsonb_agg.*JOIN expense_shares.*FROM round_members m/)
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
      await t.test('exclusion check runs AUTH, round authorization and one member/expense query without a transaction', async () => {
        for (const [actor, id, target, expected, count] of [
          [null, round.id, c.userId, 'unauthorized', 0],
          [{ ...a, userId: randomUUID() }, round.id, c.userId, 'unauthorized', 1],
          [b, round.id, c.userId, 'forbidden', 2],
          [nonParticipant, round.id, c.userId, 'not_found', 2],
          [a, randomUUID(), c.userId, 'not_found', 2],
          [a, round.id, randomUUID(), 'not_found', 3],
        ] as const) await trace(count, 'connection', () => assert.rejects(checkExclusion(actor, id, target), (error: { code: string }) => error.code === expected))
        assert.deepEqual(await trace(3, 'connection', () => checkExclusion(a, round.id, c.userId)), { allowed: true, reason: null, expenses: [] })
        assert.equal((await trace(3, 'connection', () => checkExclusion(a, round.id, a.userId))).reason, 'round_creator_cannot_leave')
        const minimum = await createRound(b, uuidV7(), group.id, { ...body, participantIds: [a.userId, b.userId] })
        await trace(2, 'connection', () => assert.rejects(checkExclusion(a, minimum.id, a.userId), (error: { code: string }) => error.code === 'forbidden'))
        assert.equal((await trace(3, 'connection', () => checkExclusion(b, minimum.id, a.userId))).reason, 'minimum_participants')
        await trace(2, 'exclude', () => assert.rejects(excludeMember(b, key(), minimum.id, a.userId, { expectedVersion: 1 }), (error: { code: string }) => error.code === 'minimum_participants'))
        for (const [splitMode, reason] of [['ALL', 'payer_and_participant'], ['SELECTED', 'selected_participant'], ['CUSTOM', 'custom_participant']] as const) {
          const inspection = await createRound(a, uuidV7(), group.id, body)
          const saved = await saveExpense(a, key(), inspection.id, { description: splitMode, amount: '101', payerId: b.userId, splitMode, expectedVersion: 1,
            ...(splitMode === 'SELECTED' ? { participantIds: [c.userId] } : splitMode === 'CUSTOM' ? { customShares: [{ userId: c.userId, amount: '101' }] } : {}) })
          const target = splitMode === 'ALL' ? b.userId : c.userId
          assert.deepEqual(await trace(3, 'connection', () => checkExclusion(a, inspection.id, target)), {
            allowed: false, reason: 'member_exclusion_blocked', expenses: [{ id: saved.id, description: splitMode, amountMinor: '101', authorId: a.userId, authorName: '회차 생성자', reason }],
          })
          const allowed = splitMode === 'ALL' ? c.userId : b.userId
          await trace(2, 'exclude', () => assert.rejects(excludeMember(a, key(), inspection.id, target, { expectedVersion: saved.version }), (error: { code: string; details: unknown }) => {
            assert.deepEqual(error.details, { allowed: false, reason: 'member_exclusion_blocked', expenses: [{ id: saved.id, description: splitMode, amountMinor: '101', authorId: a.userId, authorName: '회차 생성자', reason }] })
            return error.code === 'member_exclusion_blocked'
          }))
          assert.deepEqual(await trace(3, 'connection', () => checkExclusion(a, inspection.id, allowed)), { allowed: true, reason: null, expenses: [] })
          const confirmed = await roundCommand(a, key(), inspection.id, 'confirm', { expectedVersion: saved.version })
          assert.equal((await trace(3, 'connection', () => checkExclusion(a, inspection.id, allowed))).allowed, true)
          await trace(2, 'exclude', () => assert.rejects(excludeMember(a, key(), inspection.id, allowed, { expectedVersion: confirmed.version }), (error: { code: string }) => error.code === 'invalid_round_state'))
          await roundCommand(a, key(), inspection.id, 'send', { expectedVersion: confirmed.version })
          assert.equal((await trace(3, 'connection', () => checkExclusion(a, inspection.id, allowed))).reason, 'invalid_round_state')
        }
      })
      await t.test('concurrent exclusions preserve the version and minimum participant count without explicit locks', async () => {
        const racing = await createRound(a, uuidV7(), group.id, body)
        const results = await Promise.allSettled([b, c].map(target => excludeMember(a, key(), racing.id, target.userId, { expectedVersion: 1 })))
        assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
        assert.ok(results.filter(result => result.status === 'rejected').every(result => result.reason.code === 'stale_round'))
        const saved = await getRound(a, racing.id, new URLSearchParams())
        assert.equal(saved.version, 2)
        assert.equal(saved.memberCount, 2)
      })
      let version = 1
      const expenseKey = key(), expenseBody = { description: '지출', amount: '100', payerId: b.userId, splitMode: 'ALL', expectedVersion: version }
      let expenseAudience: { groupId: string; userIds: string[] } | undefined
      const expense = await trace(6, 'expense', () => saveExpense(a, expenseKey, round.id, expenseBody, undefined, audience => { expenseAudience = audience }))
      assert.equal(expenseAudience?.groupId, group.id)
      assert.deepEqual(new Set(expenseAudience?.userIds), new Set([a.userId, b.userId, c.userId]))
      version = expense.version!
      assert.deepEqual(await trace(5, 'expense', () => saveExpense(a, expenseKey, round.id, expenseBody, undefined, () => assert.fail('replay must not publish again'))), expense)
      await trace(0, 'expense', () => assert.rejects(saveExpense(null, '', round.id, {}), (error: { code: string }) => error.code === 'unauthorized'))
      await trace(1, 'expense', () => assert.rejects(saveExpense({ ...a, userId: randomUUID() }, '', round.id, {}), (error: { code: string }) => error.code === 'unauthorized'))
      for (const [input, expected] of [
        [{ ...expenseBody, description: '' }, 'invalid_input'],
        [{ ...expenseBody, amount: 100 }, 'invalid_amount'],
        [{ ...expenseBody, amount: '100000001' }, 'expense_amount_limit_exceeded'],
        [{ ...expenseBody, expectedVersion: '1' }, 'invalid_version'],
        [{ ...expenseBody, participantIds: [a.userId] }, 'invalid_participants'],
        [{ ...expenseBody, splitMode: 'SELECTED', participantIds: [a.userId, a.userId] }, 'invalid_participants'],
        [{ ...expenseBody, splitMode: 'CUSTOM', customShares: [{ userId: a.userId, amount: '99' }] }, 'custom_share_total_mismatch'],
      ] as const) await trace(1, 'expense', () => assert.rejects(saveExpense(a, key(), round.id, input), (error: { code: string }) => error.code === expected))
      for (const [actor, id, input, expected] of [
        [nonParticipant, round.id, { ...expenseBody, expectedVersion: version }, 'not_found'],
        [a, randomUUID(), { ...expenseBody, expectedVersion: version }, 'not_found'],
        [a, round.id, expenseBody, 'stale_round'],
        [a, round.id, { ...expenseBody, expectedVersion: version, amount: '1.00' }, 'invalid_amount'],
        [a, round.id, { ...expenseBody, expectedVersion: version, payerId: nonParticipant.userId }, 'invalid_participants'],
        [a, round.id, { ...expenseBody, expectedVersion: version, splitMode: 'SELECTED', participantIds: [nonParticipant.userId] }, 'invalid_participants'],
        [a, round.id, { ...expenseBody, expectedVersion: version, splitMode: 'CUSTOM', customShares: [{ userId: a.userId, amount: '100.00' }] }, 'invalid_amount'],
      ] as const) await trace(5, 'expense', () => assert.rejects(saveExpense(actor, key(), id, input), (error: { code: string }) => error.code === expected))
      await trace(5, 'expense', () => assert.rejects(saveExpense(a, expenseKey, round.id, { ...expenseBody, description: '다른 지출' }), (error: { code: string }) => error.code === 'idempotency_conflict'))
      const failedExpenseKey = key(), expenseConstraint = `expense_create_test_${key().replaceAll('-', '')}`
      await db.query(`ALTER TABLE mutation_requests ADD CONSTRAINT ${expenseConstraint} CHECK (request_key <> '${failedExpenseKey}') NOT VALID`)
      try {
        await trace(6, 'expense', () => assert.rejects(saveExpense(a, failedExpenseKey, round.id, { ...expenseBody, expectedVersion: version }), (error: { code: string; constraint: string }) => error.code === '23514' && error.constraint === expenseConstraint))
        assert.equal((await db.query('SELECT version FROM rounds WHERE id=$1', [round.id])).rows[0].version, version)
        assert.equal((await db.query('SELECT 1 FROM expenses WHERE round_id=$1', [round.id])).rowCount, 1)
        assert.equal((await db.query('SELECT 1 FROM expense_shares WHERE round_id=$1', [round.id])).rowCount, 3)
        assert.equal((await db.query('SELECT 1 FROM mutation_requests WHERE request_key=$1', [failedExpenseKey])).rowCount, 0)
      } finally { await db.query(`ALTER TABLE mutation_requests DROP CONSTRAINT ${expenseConstraint}`) }
      const expenseRaceRound = await createRound(a, uuidV7(), group.id, body), expenseRaceKey = key()
      const expenseRace = await Promise.all(Array.from({ length: 5 }, () => saveExpense(a, expenseRaceKey, expenseRaceRound.id, expenseBody)))
      assert.ok(expenseRace.every(result => JSON.stringify(result) === JSON.stringify(expenseRace[0])))
      assert.equal((await db.query('SELECT 1 FROM expenses WHERE round_id=$1', [expenseRaceRound.id])).rowCount, 1)
      assert.equal((await db.query('SELECT version FROM rounds WHERE id=$1', [expenseRaceRound.id])).rows[0].version, 2)
      const updated = await trace(5, 'patch', () => saveExpense(a, key(), round.id, { amount: '101', expectedVersion: version }, expense.id))
      version = updated.version!
      await t.test('expense PATCH shares the write lock and atomically saves shares, version and replay', async () => {
        const patchRound = await createRound(a, uuidV7(), group.id, body)
        const original = await saveExpense(b, key(), patchRound.id, { ...expenseBody, expectedVersion: 1 })
        let patchVersion = original.version!
        await trace(0, 'patch', () => assert.rejects(saveExpense(null, '', patchRound.id, {}, original.id), (error: { code: string }) => error.code === 'unauthorized'))
        await trace(1, 'patch', () => assert.rejects(saveExpense({ ...a, userId: randomUUID() }, '', patchRound.id, {}, original.id), (error: { code: string }) => error.code === 'unauthorized'))
        for (const [actor, id, input, expected] of [
          [c, original.id, { expectedVersion: patchVersion }, 'forbidden'],
          [nonParticipant, original.id, { expectedVersion: patchVersion }, 'not_found'],
          [a, randomUUID(), { expectedVersion: patchVersion }, 'not_found'],
          [a, original.id, { expectedVersion: 1 }, 'stale_round'],
          [a, original.id, { expectedVersion: '2' }, 'invalid_version'],
          [a, original.id, { amount: '1.00', expectedVersion: patchVersion }, 'invalid_amount'],
          [a, original.id, { currency: 'USD', expectedVersion: patchVersion }, 'invalid_input'],
          [a, original.id, { payerId: nonParticipant.userId, expectedVersion: patchVersion }, 'invalid_participants'],
          [a, original.id, { splitMode: 'CUSTOM', customShares: [{ userId: a.userId, amount: '99' }], expectedVersion: patchVersion }, 'custom_share_total_mismatch'],
        ] as const) await trace(2, 'patch', () => assert.rejects(saveExpense(actor, key(), patchRound.id, input, id), (error: { code: string }) => error.code === expected))
        for (const [actor, input] of [
          [b, { description: '기록자 수정' }],
          [a, { splitMode: 'SELECTED', participantIds: [a.userId, b.userId] }],
          [b, { description: '부담자 유지' }],
          [a, { splitMode: 'CUSTOM', customShares: [{ userId: a.userId, amount: '40' }, { userId: b.userId, amount: '60' }] }],
          [b, { description: '부담금 유지' }],
          [a, { splitMode: 'SELECTED', participantIds: [c.userId] }],
          [b, { splitMode: 'ALL' }],
        ] as const) {
          const requestKey = key(), request = { ...input, expectedVersion: patchVersion }
          const result = await trace(5, 'patch', () => saveExpense(actor, requestKey, patchRound.id, request, original.id, captured => {
            assert.equal(captured.groupId, group.id)
            assert.deepEqual(new Set(captured.userIds), new Set(body.participantIds))
          }))
          patchVersion = result.version!
          assert.deepEqual(await trace(2, 'patch', () => saveExpense(actor, requestKey, patchRound.id, request, original.id, () => assert.fail('replay must not publish'))), result)
          await trace(2, 'patch', () => assert.rejects(saveExpense(actor, requestKey, patchRound.id, { ...request, description: '다른 본문' }, original.id), (error: { code: string }) => error.code === 'idempotency_conflict'))
          const saved = (await getRound(a, patchRound.id, new URLSearchParams())).expenses[0]
          if ('participantIds' in input) assert.deepEqual(new Set(saved.participantIds), new Set(input.participantIds))
          if (saved.splitMode === 'CUSTOM') assert.deepEqual(saved.shares.map(share => share.assignedAmountMinor).sort(), ['40', '60'])
          if (saved.splitMode === 'ALL') assert.deepEqual(new Set(saved.participantIds), new Set(body.participantIds))
        }
        const before = await getRound(a, patchRound.id, new URLSearchParams())
        const failureKey = key(), constraint = `expense_patch_test_${key().replaceAll('-', '')}`
        await db.query(`ALTER TABLE mutation_requests ADD CONSTRAINT ${constraint} CHECK (request_key <> '${failureKey}') NOT VALID`)
        try {
          await trace(5, 'patch', () => assert.rejects(saveExpense(a, failureKey, patchRound.id, { amount: '200', splitMode: 'SELECTED', participantIds: [a.userId], expectedVersion: patchVersion }, original.id), (error: { code: string }) => error.code === '23514'))
          assert.deepEqual(await getRound(a, patchRound.id, new URLSearchParams()), before)
          assert.equal((await db.query('SELECT 1 FROM mutation_requests WHERE request_key=$1', [failureKey])).rowCount, 0)
        } finally { await db.query(`ALTER TABLE mutation_requests DROP CONSTRAINT ${constraint}`) }
        const sameKey = key(), sameBody = { description: '동시 재전송', expectedVersion: patchVersion }
        const repeated = await Promise.all(Array.from({ length: 5 }, () => saveExpense(b, sameKey, patchRound.id, sameBody, original.id)))
        assert.ok(repeated.every(result => JSON.stringify(result) === JSON.stringify(repeated[0])))
        patchVersion = repeated[0].version!
        assert.equal(patchVersion, before.version + 1)
        const different = await Promise.allSettled([a, b].map(actor => saveExpense(actor, key(), patchRound.id, { description: actor.userId, expectedVersion: patchVersion }, original.id)))
        assert.equal(different.filter(result => result.status === 'fulfilled').length, 1)
        assert.ok(different.some(result => result.status === 'rejected' && result.reason.code === 'stale_round'))
        patchVersion++
        const confirmed = await roundCommand(a, key(), patchRound.id, 'confirm', { expectedVersion: patchVersion })
        await trace(2, 'patch', () => assert.rejects(saveExpense(b, key(), patchRound.id, { expectedVersion: confirmed.version }, original.id), (error: { code: string }) => error.code === 'invalid_round_state'))
      })
      await t.test('expense DELETE checks permissions before locking and commits one atomic deletion before receipt cleanup', async () => {
        const storage = new S3Client({ endpoint: process.env.MINIO_ENDPOINT, region: 'us-east-1', forcePathStyle: true,
          credentials: { accessKeyId: process.env.MINIO_ACCESS_KEY!, secretAccessKey: process.env.MINIO_SECRET_KEY! } })
        const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } }).png().toBuffer()
        try {
          for (const actor of [b, a]) {
            const deletionRound = await createRound(a, uuidV7(), group.id, body)
            const original = await saveExpense(b, key(), deletionRound.id, { ...expenseBody, amount: '300', expectedVersion: 1 })
            const receipt = await addReceipt(b, key(), deletionRound.id, original.id, original.version!, bytes, 'image/png')
            const request = { expectedVersion: receipt.version! }, requestKey = key()
            const objectKey = (await db.query('SELECT object_key FROM expense_receipts WHERE id=$1', [receipt.id])).rows[0].object_key
            const head = { Bucket: process.env.MINIO_BUCKET!, Key: objectKey }
            await trace(2, 'delete', () => assert.rejects(deleteExpense(null, '', deletionRound.id, original.id, {}), (error: { code: string }) => error.code === 'unauthorized'))
            await trace(3, 'delete', () => assert.rejects(deleteExpense({ ...a, userId: randomUUID() }, '', deletionRound.id, original.id, {}), (error: { code: string }) => error.code === 'unauthorized'))
            await trace(3, 'delete', () => assert.rejects(deleteExpense(a, key(), deletionRound.id, original.id, { ...request, amount: '1' }), (error: { code: string }) => error.code === 'invalid_input'))
            for (const [caller, id, input, expected] of [
              [c, original.id, request, 'forbidden'],
              [nonParticipant, original.id, request, 'not_found'],
              [a, randomUUID(), request, 'not_found'],
              [a, original.id, { expectedVersion: 1 }, 'stale_round'],
              [a, original.id, { expectedVersion: '3' }, 'invalid_version'],
            ] as const) await trace(4, 'delete', () => assert.rejects(deleteExpense(caller, key(), deletionRound.id, id, input), (error: { code: string }) => error.code === expected))

            const before = await getRound(a, deletionRound.id, new URLSearchParams())
            assert.equal(before.totalMinor, '300')
            assert.equal(before.transfers.length, 1)
            const failureKey = key(), constraint = `expense_delete_test_${key().replaceAll('-', '')}`
            await db.query(`ALTER TABLE mutation_requests ADD CONSTRAINT ${constraint} CHECK (request_key <> '${failureKey}') NOT VALID`)
            try {
              await trace(6, 'delete', () => assert.rejects(deleteExpense(actor, failureKey, deletionRound.id, original.id, request, () => assert.fail('rollback must not publish')), (error: { code: string }) => error.code === '23514'))
              assert.deepEqual(await getRound(a, deletionRound.id, new URLSearchParams()), before)
              assert.equal((await db.query('SELECT 1 FROM mutation_requests WHERE request_key=$1', [failureKey])).rowCount, 0)
              await storage.send(new HeadObjectCommand(head))
            } finally { await db.query(`ALTER TABLE mutation_requests DROP CONSTRAINT ${constraint}`) }

            let cleanups = 0
            const send = t.mock.method(S3Client.prototype, 'send', new Proxy(S3Client.prototype.send, {
              apply(target, receiver, args) {
                if (args[0] instanceof DeleteObjectCommand) {
                  assert.equal(statements.at(-1), 'COMMIT')
                  cleanups++
                  if (actor === a) return Promise.reject(new Error('test receipt cleanup failure'))
                }
                return Reflect.apply(target, receiver, args)
              },
            }))
            const errors = t.mock.method(console, 'error', () => {})
            try {
              const result = await trace(6, 'delete', () => deleteExpense(actor, requestKey, deletionRound.id, original.id, request, audience => {
                assert.equal(audience.groupId, group.id)
                assert.deepEqual(new Set(audience.userIds), new Set(body.participantIds))
              }))
              assert.equal(result.version, request.expectedVersion + 1)
              assert.deepEqual(await trace(5, 'delete', () => deleteExpense(actor, requestKey, deletionRound.id, original.id, request, () => assert.fail('replay must not publish'))), result)
              await trace(4, 'delete', () => assert.rejects(deleteExpense(actor, requestKey, deletionRound.id, original.id, { expectedVersion: result.version }), (error: { code: string }) => error.code === 'idempotency_conflict'))
              assert.equal(cleanups, 1)
              assert.equal(errors.mock.callCount(), actor === a ? 1 : 0)
              const current = await getRound(a, deletionRound.id, new URLSearchParams())
              assert.equal(current.version, result.version)
              assert.equal(current.totalMinor, '0')
              assert.deepEqual(current.expenses, [])
              assert.deepEqual(current.transfers, [])
              assert.equal((await db.query('SELECT 1 FROM expense_shares WHERE expense_id=$1', [original.id])).rowCount, 0)
              assert.equal((await db.query('SELECT 1 FROM expense_receipts WHERE expense_id=$1', [original.id])).rowCount, 0)
              if (actor === b) await assert.rejects(storage.send(new HeadObjectCommand(head)), (error: { $metadata?: { httpStatusCode?: number } }) => error.$metadata?.httpStatusCode === 404)
            } finally { send.mock.restore(); errors.mock.restore(); await storage.send(new DeleteObjectCommand(head)) }
          }
        } finally { storage.destroy() }
      })
      const participantExpense = await trace(6, 'expense', () => saveExpense(b, key(), round.id, { ...expenseBody, expectedVersion: version }))
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
      const deleted = await trace(6, 'delete', () => deleteExpense(b, key(), round.id, participantExpense.id, { expectedVersion: version }))
      version = deleted.version!
      const receiptKey = key(), receiptVersion = version
      const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } }).png().toBuffer()
      const receipt = await trace(2, 'receipt', () => addReceipt(a, receiptKey, round.id, expense.id, receiptVersion, bytes, 'image/png'))
      version = receipt.version!
      await trace(2, 'receipt', () => addReceipt(a, receiptKey, round.id, expense.id, receiptVersion, bytes, 'image/png'))
      const stored = await trace(2, 'receipt-read', () => getReceipt(b, receipt.id))
      assert.equal(stored.mimeType, 'image/avif')
      const removed = await trace(10, true, () => removeReceipt(a, key(), round.id, expense.id, receipt.id, { expectedVersion: version }))
      version = removed.version!
      assert.equal((await trace(3, 'connection', () => checkExclusion(a, round.id, c.userId))).allowed, true)
      for (const [actor, id, target, ticket, input, expected, count] of [
        [null, round.id, c.userId, '', { unexpected: true }, 'unauthorized', 0],
        [{ ...a, userId: randomUUID() }, round.id, c.userId, '', { unexpected: true }, 'unauthorized', 1],
        [a, round.id, c.userId, key(), { unexpected: true }, 'invalid_input', 1],
        [a, round.id, c.userId, '', { expectedVersion: version }, 'invalid_request_key', 1],
        [b, round.id, randomUUID(), key(), { expectedVersion: version }, 'forbidden', 2],
        [nonParticipant, round.id, c.userId, key(), { expectedVersion: version }, 'not_found', 2],
        [a, randomUUID(), c.userId, key(), { expectedVersion: version }, 'not_found', 2],
        [a, round.id, randomUUID(), key(), { expectedVersion: version }, 'not_found', 2],
        [a, round.id, a.userId, key(), { expectedVersion: version }, 'member_exclusion_blocked', 2],
        [a, round.id, c.userId, key(), { expectedVersion: '1' }, 'invalid_version', 2],
        [a, round.id, c.userId, key(), { expectedVersion: version - 1 }, 'stale_round', 2],
      ] as const) await trace(count, 'exclude', () => assert.rejects(excludeMember(actor, ticket, id, target, input), (error: { code: string }) => error.code === expected))
      const beforeExclusion = await getRound(a, round.id, new URLSearchParams())
      const exclusionConstraint = `member_exclude_test_${key().replaceAll('-', '')}`
      await db.query(`ALTER TABLE round_members ADD CONSTRAINT ${exclusionConstraint} CHECK (round_id <> '${round.id}' OR user_id <> '${c.userId}' OR excluded_at IS NULL) NOT VALID`)
      try {
        await trace(3, 'exclude', () => assert.rejects(excludeMember(a, key(), round.id, c.userId, { expectedVersion: version }, () => assert.fail('failed save must not publish')), (error: { code: string }) => error.code === '23514'))
        assert.deepEqual(await getRound(a, round.id, new URLSearchParams()), beforeExclusion)
      } finally { await db.query(`ALTER TABLE round_members DROP CONSTRAINT ${exclusionConstraint}`) }
      const exclusionKey = key(), exclusionVersion = version
      let exclusionAudience: { groupId: string; userIds: string[]; groupUserIds: string[] } | undefined
      const excluded = await trace(3, 'exclude', () => excludeMember(a, exclusionKey, round.id, c.userId, { expectedVersion: version }, audience => { exclusionAudience = audience }))
      assert.equal(excluded.version, exclusionVersion + 1)
      assert.equal(exclusionAudience?.groupId, group.id)
      assert.deepEqual(new Set(exclusionAudience?.userIds), new Set([a.userId, b.userId, c.userId]))
      assert.deepEqual(new Set(exclusionAudience?.groupUserIds), new Set([a.userId, b.userId, c.userId, nonParticipant.userId]))
      for (const ticket of [exclusionKey, key()]) await trace(2, 'exclude', () => assert.rejects(excludeMember(a, ticket, round.id, c.userId, { expectedVersion: exclusionVersion }, () => assert.fail('repeat must not publish')), (error: { code: string; status: number }) => error.code === 'not_found' && error.status === 404))
      const afterExclusion = await getRound(a, round.id, new URLSearchParams())
      assert.equal(afterExclusion.version, excluded.version)
      assert.equal(afterExclusion.totalMinor, beforeExclusion.totalMinor)
      assert.ok(afterExclusion.expenses.every(item => item.participantIds.length === 2 && !item.participantIds.includes(c.userId)))
      assert.equal((await db.query('SELECT 1 FROM mutation_requests WHERE request_key=$1', [exclusionKey])).rowCount, 0)
      version = excluded.version!
      await t.test('confirm uses six statements regardless of expenses and preserves validation, rollback and replay', async t => {
        const confirmation = await createRound(b, uuidV7(), group.id, { ...body, participantIds: [a.userId, b.userId] })
        for (const [actor, ticket, id, input, expected, count] of [
          [null, '', confirmation.id, {}, 'unauthorized', 0],
          [{ ...b, userId: randomUUID() }, '', confirmation.id, {}, 'unauthorized', 1],
          [b, '', confirmation.id, {}, 'invalid_request_key', 1],
          [a, key(), confirmation.id, { expectedVersion: 1 }, 'forbidden', 4],
          [nonParticipant, key(), confirmation.id, { expectedVersion: 1 }, 'not_found', 4],
          [b, key(), randomUUID(), { expectedVersion: 1 }, 'not_found', 4],
          [b, key(), confirmation.id, { expectedVersion: 2 }, 'stale_round', 4],
          [b, key(), confirmation.id, { expectedVersion: 1 }, 'empty_expenses', 4],
        ] as const) await trace(count, 'confirm', () => assert.rejects(roundCommand(actor, ticket, id, 'confirm', input), (error: { code: string }) => error.code === expected))
        let expectedVersion = 1
        for (const splitMode of ['ALL', 'SELECTED', 'CUSTOM'] as const) {
          expectedVersion = (await saveExpense(b, key(), confirmation.id, { description: splitMode, amount: '101', payerId: b.userId, splitMode, expectedVersion,
            ...(splitMode === 'SELECTED' ? { participantIds: [a.userId, b.userId] } : splitMode === 'CUSTOM' ? { customShares: [{ userId: a.userId, amount: '40' }, { userId: b.userId, amount: '61' }] } : {}) })).version!
        }
        const requestKey = key(), request = { expectedVersion }
        const constraint = `confirm_test_${key().replaceAll('-', '')}`
        await db.query(`ALTER TABLE expenses ADD CONSTRAINT ${constraint} CHECK (round_id <> '${confirmation.id}' OR base_share_minor IS NULL) NOT VALID`)
        try {
          await trace(6, 'confirm', () => assert.rejects(roundCommand(b, requestKey, confirmation.id, 'confirm', request), (error: { code: string }) => error.code === '23514'))
          const unchanged = await getRound(b, confirmation.id, new URLSearchParams())
          assert.equal(unchanged.status, 'RECORDING')
          assert.equal(unchanged.version, expectedVersion)
          assert.equal((await db.query('SELECT 1 FROM expenses WHERE round_id=$1 AND (base_share_minor IS NOT NULL OR remainder_units IS NOT NULL)', [confirmation.id])).rowCount, 0)
          assert.equal((await db.query('SELECT 1 FROM mutation_requests WHERE request_key=$1', [requestKey])).rowCount, 0)
        } finally { await db.query(`ALTER TABLE expenses DROP CONSTRAINT ${constraint}`) }
        const result = await trace(6, 'confirm', () => roundCommand(b, requestKey, confirmation.id, 'confirm', request, audience => {
          assert.equal(audience.groupId, group.id)
          assert.deepEqual(new Set(audience.userIds), new Set([a.userId, b.userId]))
        }))
        assert.equal(result.status, 'CONFIRMED')
        assert.equal(result.version, expectedVersion + 1)
        const confirmed = await getRound(b, confirmation.id, new URLSearchParams())
        for (const expense of confirmed.expenses) {
          if (expense.splitMode === 'CUSTOM') assert.deepEqual(expense.shares.map(share => share.assignedAmountMinor).sort(), ['40', '61'])
          else { assert.equal(expense.baseShareMinor, '50'); assert.equal(expense.remainderUnits, 1) }
        }
        assert.deepEqual(await trace(5, 'confirm', () => roundCommand(b, requestKey, confirmation.id, 'confirm', request, () => assert.fail('replay must not publish'))), result)
        await trace(4, 'confirm', () => assert.rejects(roundCommand(b, requestKey, confirmation.id, 'confirm', { expectedVersion: result.version }), (error: { code: string }) => error.code === 'idempotency_conflict'))
        await trace(4, 'confirm', () => assert.rejects(roundCommand(b, key(), confirmation.id, 'confirm', { expectedVersion: result.version }), (error: { code: string }) => error.code === 'invalid_round_state'))
        await t.test('reopen uses AUTH then round then one atomic save without locks or replay', async () => {
          const requestKey = key(), request = { expectedVersion: result.version }
          for (const [actor, ticket, id, input, expected, count] of [
            [null, '', confirmation.id, {}, 'unauthorized', 0],
            [{ ...b, userId: randomUUID() }, '', confirmation.id, {}, 'unauthorized', 1],
            [b, '', confirmation.id, request, 'invalid_request_key', 1],
            [b, key(), confirmation.id, { unexpected: true }, 'invalid_input', 1],
            [a, key(), confirmation.id, request, 'forbidden', 2],
            [nonParticipant, key(), confirmation.id, request, 'not_found', 2],
            [b, key(), randomUUID(), request, 'not_found', 2],
            [b, key(), confirmation.id, { expectedVersion: '1' }, 'invalid_version', 2],
            [b, key(), confirmation.id, { expectedVersion: result.version! - 1 }, 'stale_round', 2],
          ] as const) await trace(count, 'reopen', () => assert.rejects(roundCommand(actor, ticket, id, 'reopen', input), (error: { code: string }) => error.code === expected))
          const constraint = `reopen_test_${key().replaceAll('-', '')}`
          await db.query(`ALTER TABLE expenses ADD CONSTRAINT ${constraint} CHECK (round_id <> '${confirmation.id}' OR split_mode='CUSTOM' OR base_share_minor IS NOT NULL) NOT VALID`)
          try {
            await trace(3, 'reopen', () => assert.rejects(roundCommand(b, requestKey, confirmation.id, 'reopen', request, () => assert.fail('failed save must not publish')), (error: { code: string }) => error.code === '23514'))
            assert.deepEqual(await getRound(b, confirmation.id, new URLSearchParams()), confirmed)
          } finally { await db.query(`ALTER TABLE expenses DROP CONSTRAINT ${constraint}`) }
          const reopened = await trace(3, 'reopen', () => roundCommand(b, requestKey, confirmation.id, 'reopen', request, audience => {
            assert.equal(audience.groupId, group.id)
            assert.deepEqual(new Set(audience.userIds), new Set([a.userId, b.userId]))
          }))
          assert.deepEqual(reopened, { id: confirmation.id, roundId: confirmation.id, status: 'RECORDING', version: result.version! + 1 })
          for (const ticket of [requestKey, key()]) await trace(2, 'reopen', () => assert.rejects(roundCommand(b, ticket, confirmation.id, 'reopen', request, () => assert.fail('repeat must not publish')), (error: { code: string; status: number }) => error.code === 'invalid_round_state' && error.status === 409))
          const current = await getRound(b, confirmation.id, new URLSearchParams())
          assert.equal(current.version, reopened.version)
          assert.equal(current.currency, confirmed.currency)
          assert.deepEqual(current.members, confirmed.members)
          for (const expense of current.expenses) {
            assert.equal(expense.baseShareMinor, expense.splitMode === 'CUSTOM' ? null : '50')
            assert.deepEqual(expense.shares, confirmed.expenses.find(item => item.id === expense.id)!.shares)
          }
          assert.equal((await db.query('SELECT 1 FROM expenses WHERE round_id=$1 AND (base_share_minor IS NOT NULL OR remainder_units IS NOT NULL)', [confirmation.id])).rowCount, 0)
          assert.equal((await db.query('SELECT confirmed_at FROM rounds WHERE id=$1', [confirmation.id])).rows[0].confirmed_at, null)
          assert.equal((await db.query('SELECT 1 FROM mutation_requests WHERE request_key=$1', [requestKey])).rowCount, 0)
        })
      })
      assert.equal((await trace(3, 'connection', () => checkExclusion(a, round.id, c.userId))).reason, 'already_excluded')
      await t.test('settlement uses AUTH then one authorized query before finalization', async () => {
        for (const [actor, id, expected, count] of [
          [null, round.id, 'unauthorized', 0],
          [{ ...a, userId: randomUUID() }, round.id, 'unauthorized', 1],
          [nonParticipant, round.id, 'not_found', 2],
          [a, randomUUID(), 'not_found', 2],
        ] as const) await trace(count, 'settlement', () => assert.rejects(getSettlement(actor, id), (error: { code: string }) => error.code === expected))
        for (const actor of [a, b, c]) {
          const pending = await trace(2, 'settlement', () => getSettlement(actor, round.id))
          assert.equal(pending.status, 'RECORDING')
          assert.equal(pending.finalized, false)
          assert.equal(pending.balanceMinor, null)
          assert.equal(pending.sharePath, null)
          assert.deepEqual(pending.outgoing, [])
          assert.deepEqual(pending.incoming, [])
          assert.deepEqual(pending.confirmations, [])
          assert.equal(pending.allChecked, true)
        }
      })
      const command = async (action: string, count: number) => {
        const result = await trace(count, ['confirm', 'reopen', 'draw'].includes(action) ? action as 'confirm' | 'reopen' | 'draw' : true, () => roundCommand(a, key(), round.id, action, { expectedVersion: version }))
        version = result.version!
      }
      await command('confirm', 6)
      await command('reopen', 3)
      await command('confirm', 6)
      assert.equal((await trace(2, 'settlement', () => getSettlement(a, round.id))).finalized, false)
      await command('send', 12)
      assert.equal((await trace(2, 'settlement', () => getSettlement(a, round.id))).finalized, false)
      await trace(2, 'complete', () => assert.rejects(roundCommand(a, key(), round.id, 'complete', { expectedVersion: version }),
        (error: { code: string }) => error.code === 'invalid_round_state'))
      await t.test('draw uses AUTH then round then one atomic final save', async () => {
        const requestKey = key(), request = { expectedVersion: version }
        for (const [actor, ticket, id, input, expected, count] of [
          [null, '', round.id, {}, 'unauthorized', 0],
          [{ ...a, userId: randomUUID() }, '', round.id, {}, 'unauthorized', 1],
          [a, '', round.id, request, 'invalid_request_key', 1],
          [a, key(), round.id, { unexpected: true }, 'invalid_input', 1],
          [b, key(), round.id, request, 'forbidden', 2],
          [nonParticipant, key(), round.id, request, 'not_found', 2],
          [a, key(), randomUUID(), request, 'not_found', 2],
          [a, key(), round.id, { expectedVersion: '1' }, 'invalid_version', 2],
          [a, key(), round.id, { expectedVersion: version - 1 }, 'stale_round', 2],
        ] as const) await trace(count, 'draw', () => assert.rejects(roundCommand(actor, ticket, id, 'draw', input), (error: { code: string }) => error.code === expected))
        const result = await trace(3, 'draw', () => roundCommand(a, requestKey, round.id, 'draw', request, audience => {
          assert.equal(audience.groupId, group.id)
          assert.deepEqual(new Set(audience.userIds), new Set([a.userId, b.userId, c.userId]))
        }))
        assert.equal(result.status, 'LOCKED')
        assert.equal(result.version, version + 1)
        assert.deepEqual(await trace(2, 'draw', () => roundCommand(a, requestKey, round.id, 'draw', request, () => assert.fail('replay must not publish'))), result)
        await trace(2, 'draw', () => assert.rejects(roundCommand(a, requestKey, round.id, 'draw', { expectedVersion: result.version }), (error: { code: string }) => error.code === 'idempotency_conflict'))
        assert.deepEqual(await trace(3, 'draw', () => roundCommand(a, key(), round.id, 'draw', request, () => assert.fail('saved draw must not publish'))), result)
        version = result.version!
      })
      await trace(2, 'connection', () => getRound(a, round.id, new URLSearchParams()))
      const settlement = await trace(2, 'settlement', () => getSettlement(a, round.id))
      assert.equal(settlement.outgoing.length, 1)
      assert.ok(settlement.outgoing[0].account)
      const receiver = await trace(2, 'settlement', () => getSettlement(b, round.id))
      assert.equal(receiver.incoming.length, 1)
      assert.equal(receiver.incoming[0].senderId, a.userId)
      assert.equal(receiver.incoming[0].amountMinor, settlement.outgoing[0].amountMinor)
      assert.equal(receiver.incoming[0].receivedAt, null)
      assert.equal(receiver.checkRequired, true)
      assert.deepEqual(receiver.outgoing, [])
      const checkKey = key(), checkBody = { checked: true, senderId: a.userId, expectedVersion: version }
      for (const [actor, ticket, input, count, expected] of [
        [null, checkKey, { checked: 'yes' }, 0, 'unauthorized'],
        [{ ...b, userId: randomUUID() }, checkKey, { checked: 'yes' }, 1, 'unauthorized'],
        [b, checkKey, { ...checkBody, checked: 'yes' }, 1, 'invalid_input'],
        [b, checkKey, { ...checkBody, senderId: ' sender ' }, 1, 'invalid_input'],
        [b, checkKey, { ...checkBody, extra: true }, 1, 'invalid_input'],
        [b, 'invalid-key', checkBody, 1, 'invalid_request_key'],
        [b, checkKey, { ...checkBody, expectedVersion: version + 1 }, 2, 'stale_round'],
        [b, checkKey, { ...checkBody, senderId: c.userId }, 2, 'forbidden'],
        [a, checkKey, checkBody, 2, 'forbidden'],
        [b, checkKey, { ...checkBody, checked: false }, 2, 'not_found'],
      ] as const) await trace(count, 'check', () => assert.rejects(setSettlementCheck(actor, ticket, round.id, input), (error: { code: string }) => error.code === expected))
      const checked = await trace(3, 'check', () => setSettlementCheck(b, checkKey, round.id, checkBody, audience => {
        assert.equal(audience.groupId, group.id)
        assert.deepEqual(new Set(audience.userIds), new Set([a.userId, b.userId, c.userId]))
      }))
      assert.equal(checked.version, version)
      for (const ticket of [checkKey, key()]) await trace(2, 'check', () => assert.rejects(setSettlementCheck(b, ticket, round.id, checkBody,
        () => assert.fail('unchanged checks must not publish')), (error: { code: string }) => error.code === 'not_found'))
      const received = await trace(2, 'settlement', () => getSettlement(b, round.id))
      assert.notEqual(received.incoming[0].receivedAt, null)
      assert.equal(received.checkedAt, received.incoming[0].receivedAt)
      assert.equal(received.checkedCount, 1)
      assert.equal(received.allChecked, true)
      assert.deepEqual((await trace(2, 'settlement', () => getSettlement(a, round.id))).outgoing, [])
      assert.equal(received.balanceMinor, receiver.balanceMinor, 'original settlement balances are immutable')
      await trace(3, 'check', () => setSettlementCheck(b, key(), round.id, { ...checkBody, checked: false }))
      assert.notEqual((await trace(2, 'settlement', () => getSettlement(a, round.id))).outgoing.length, 0)
      await trace(3, 'check', () => setSettlementCheck(b, key(), round.id, checkBody))
      await t.test('complete checks pending transfers inside one atomic save after AUTH; rejection and replay also use two queries', async () => {
        const requestKey = key(), request = { expectedVersion: version }
        for (const [actor, ticket, id, input, expected, count] of [
          [null, '', round.id, {}, 'unauthorized', 0],
          [{ ...a, userId: randomUUID() }, '', round.id, {}, 'unauthorized', 1],
          [a, '', round.id, request, 'invalid_request_key', 1],
          [a, key(), round.id, { unexpected: true }, 'invalid_input', 1],
          [b, key(), round.id, request, 'forbidden', 2],
          [nonParticipant, key(), round.id, request, 'not_found', 2],
          [a, key(), randomUUID(), request, 'not_found', 2],
          [a, key(), round.id, { expectedVersion: '1' }, 'invalid_version', 2],
          [a, key(), round.id, { expectedVersion: version - 1 }, 'stale_round', 2],
        ] as const) await trace(count, 'complete', () => assert.rejects(roundCommand(actor, ticket, id, 'complete', input), (error: { code: string }) => error.code === expected))
        await setSettlementCheck(b, key(), round.id, { ...checkBody, checked: false })
        await trace(2, 'complete', () => assert.rejects(roundCommand(a, requestKey, round.id, 'complete', request, () => assert.fail('rejection must not publish')),
          (error: { code: string; details: { pendingCount: number } }) => error.code === 'pending_settlement_checks' && error.details.pendingCount === 1))
        assert.equal((await getRound(a, round.id, new URLSearchParams())).status, 'LOCKED')
        await setSettlementCheck(b, key(), round.id, checkBody)
        const constraint = `complete_test_${key().replaceAll('-', '')}`
        await db.query(`ALTER TABLE mutation_requests ADD CONSTRAINT ${constraint} CHECK (request_key <> '${requestKey}') NOT VALID`)
        try {
          await trace(2, 'complete', () => assert.rejects(roundCommand(a, requestKey, round.id, 'complete', request, () => assert.fail('failed save must not publish')),
            (error: { code: string }) => error.code === '23514'))
          const current = await getRound(a, round.id, new URLSearchParams())
          assert.equal(current.status, 'LOCKED')
          assert.equal(current.version, version)
          assert.equal(current.completedAt, null)
        } finally { await db.query(`ALTER TABLE mutation_requests DROP CONSTRAINT ${constraint}`) }
        const result = await trace(2, 'complete', () => roundCommand(a, requestKey, round.id, 'complete', request, audience => {
          assert.equal(audience.groupId, group.id)
          assert.deepEqual(new Set(audience.userIds), new Set([a.userId, b.userId, c.userId]))
        }))
        assert.deepEqual(result, { id: round.id, roundId: round.id, status: 'COMPLETED', version: version + 1 })
        assert.deepEqual(await trace(2, 'complete', () => roundCommand(a, requestKey, round.id, 'complete', request, () => assert.fail('replay must not publish'))), result)
        await trace(2, 'complete', () => assert.rejects(roundCommand(a, requestKey, round.id, 'complete', { expectedVersion: result.version }),
          (error: { code: string }) => error.code === 'idempotency_conflict'))
        await trace(2, 'complete', () => assert.rejects(roundCommand(a, key(), round.id, 'complete', { expectedVersion: result.version }),
          (error: { code: string }) => error.code === 'invalid_round_state'))
        version = result.version!
      })
      assert.equal((await trace(2, 'settlement', () => getSettlement(b, round.id))).status, 'COMPLETED')
      await trace(2, 'check', () => assert.rejects(setSettlementCheck(b, key(), round.id, { ...checkBody, expectedVersion: version, checked: false }),
        (error: { code: string }) => error.code === 'invalid_round_state'))
      await t.test('settlement omits accounts for non-KRW transfers in two SQL calls', async () => {
        const foreign = await createRound(a, uuidV7(), group.id, { ...body, currency: 'USD', participantIds: [a.userId, b.userId] })
        const saved = await saveExpense(a, key(), foreign.id, { description: '외화', amount: '0.30', payerId: b.userId, splitMode: 'ALL', expectedVersion: 1 })
        const confirmed = await roundCommand(a, key(), foreign.id, 'confirm', { expectedVersion: saved.version })
        await roundCommand(a, key(), foreign.id, 'send', { expectedVersion: confirmed.version })
        const sender = await trace(2, 'settlement', () => getSettlement(a, foreign.id))
        assert.equal(sender.balanceMinor, '15')
        assert.equal(sender.outgoing[0].amountMinor, '15')
        assert.equal('account' in sender.outgoing[0], false)
        assert.equal(JSON.stringify(sender).includes('검증 은행'), false)
        assert.equal((await trace(2, 'settlement', () => getSettlement(b, foreign.id))).balanceMinor, '-15')
      })
      const cancelled = await trace(4, 'session', () => createRound(a, uuidV7(), group.id, { ...body, participantIds: [a.userId, b.userId] }))
      for (const [actor, count] of [[null, 2], [{ ...a, userId: randomUUID() }, 3]] as const) {
        statements = []
        await assert.rejects(roundCommand(actor, '', cancelled.id, 'cancel', {}), (error: { code: string }) => error.code === 'unauthorized')
        assert.equal(statements.length, count)
        assert.equal(statements[0], 'BEGIN')
        assert.equal(statements.at(-1), 'ROLLBACK')
        assert.ok(statements.every(sql => !sql.includes('pg_advisory')))
      }
      const historical = await trace(2, 'connection', () => listRounds(c, new URLSearchParams(), group.id))
      assert.ok(historical.items.some(item => item.id === round.id), 'excluded participants retain round history')
      assert.ok(historical.items.every(item => item.id !== cancelled.id), 'group membership alone does not expose a round')
      for (const [actor, id, input, expected] of [
        [b, cancelled.id, { expectedVersion: 1 }, 'forbidden'],
        [c, cancelled.id, { expectedVersion: 1 }, 'not_found'],
        [a, randomUUID(), { expectedVersion: 1 }, 'not_found'],
        [a, cancelled.id, { expectedVersion: 2 }, 'stale_round'],
        [a, cancelled.id, { expectedVersion: '1' }, 'invalid_version'],
        [a, round.id, { expectedVersion: version }, 'invalid_round_state'],
      ] as const) await trace(5, 'cancel', () => assert.rejects(roundCommand(actor, key(), id, 'cancel', input), (error: { code: string }) => error.code === expected))
      const failedCancelKey = key(), cancelConstraint = `round_cancel_test_${key().replaceAll('-', '')}`
      await db.query(`ALTER TABLE mutation_requests ADD CONSTRAINT ${cancelConstraint} CHECK (request_key <> '${failedCancelKey}') NOT VALID`)
      try {
        await trace(6, 'cancel', () => assert.rejects(roundCommand(a, failedCancelKey, cancelled.id, 'cancel', { expectedVersion: 1 }), (error: { code: string; constraint: string }) => error.code === '23514' && error.constraint === cancelConstraint))
        assert.equal((await db.query('SELECT 1 FROM rounds WHERE id=$1', [cancelled.id])).rowCount, 1)
        assert.equal((await db.query('SELECT 1 FROM round_members WHERE round_id=$1', [cancelled.id])).rowCount, 2)
        assert.equal((await db.query('SELECT 1 FROM mutation_requests WHERE request_key=$1', [failedCancelKey])).rowCount, 0)
      } finally { await db.query(`ALTER TABLE mutation_requests DROP CONSTRAINT ${cancelConstraint}`) }
      let audience: { groupId: string; userIds: string[] } | undefined
      const cancelKey = key(), cancelBody = { expectedVersion: 1 }
      const cancellation = await trace(6, 'cancel', () => roundCommand(a, cancelKey, cancelled.id, 'cancel', cancelBody, captured => { audience = captured }))
      assert.equal(audience?.groupId, group.id)
      assert.deepEqual(new Set(audience?.userIds), new Set([a.userId, b.userId]))
      assert.equal((await db.query('SELECT 1 FROM round_members WHERE round_id=$1', [cancelled.id])).rowCount, 0)
      assert.deepEqual(await trace(5, 'cancel', () => roundCommand(a, cancelKey, cancelled.id, 'cancel', cancelBody, () => assert.fail('replay must not publish again'))), cancellation)
      await trace(5, 'cancel', () => assert.rejects(roundCommand(a, cancelKey, cancelled.id, 'cancel', { expectedVersion: 2 }), (error: { code: string }) => error.code === 'idempotency_conflict'))
      await trace(5, 'cancel', () => assert.rejects(roundCommand(a, key(), cancelled.id, 'cancel', cancelBody), (error: { code: string }) => error.code === 'not_found'))
      const racing = await createRound(a, uuidV7(), group.id, body)
      const race = await Promise.allSettled([
        roundCommand(a, key(), racing.id, 'cancel', cancelBody),
        saveExpense(a, key(), racing.id, { ...expenseBody, expectedVersion: 1 }),
      ])
      assert.equal(race.filter(result => result.status === 'fulfilled').length, 1)
      if (race[0].status === 'fulfilled') assert.equal((await db.query('SELECT 1 FROM expenses WHERE round_id=$1', [racing.id])).rowCount, 0)
      else assert.equal((await getRound(a, racing.id, new URLSearchParams())).expenses.length, 1)
      const even = await trace(4, 'session', () => createRound(a, uuidV7(), group.id, { ...body, participantIds: [a.userId, b.userId] }))
      let evenVersion = (await trace(6, 'expense', () => saveExpense(a, key(), even.id, { ...expenseBody, amount: '100', expectedVersion: 1 }))).version!
      const nonemptyKey = key()
      await trace(5, 'cancel', () => assert.rejects(roundCommand(a, nonemptyKey, even.id, 'cancel', { expectedVersion: evenVersion }), (error: { code: string }) => error.code === 'round_has_expenses'))
      assert.equal((await db.query('SELECT 1 FROM mutation_requests WHERE request_key=$1', [nonemptyKey])).rowCount, 0)
      assert.equal((await getRound(a, even.id, new URLSearchParams())).expenses.length, 1)
      const probe = createDatabaseClient(database)
      await probe.connect()
      try {
        assert.equal((await probe.query('SELECT pg_try_advisory_lock(1684106607) AS acquired')).rows[0].acquired, true)
        await probe.query('SELECT pg_advisory_unlock(1684106607)')
      } finally { await probe.end() }
      evenVersion = (await trace(6, 'confirm', () => roundCommand(a, key(), even.id, 'confirm', { expectedVersion: evenVersion }))).version!
      // Two shares + two balances + one transfer, finalized directly by send.
      evenVersion = (await trace(20, true, () => roundCommand(a, key(), even.id, 'send', { expectedVersion: evenVersion }))).version!
      await t.test('force completion reads pending receivers and atomically saves status, version and replay in three queries', async () => {
        const requestKey = key(), request = { expectedVersion: evenVersion }
        for (const [actor, ticket, id, input, expected, count] of [
          [null, '', even.id, {}, 'unauthorized', 0],
          [{ ...a, userId: randomUUID() }, '', even.id, {}, 'unauthorized', 1],
          [a, '', even.id, request, 'invalid_request_key', 1],
          [a, key(), even.id, { unexpected: true }, 'invalid_input', 1],
          [b, key(), even.id, request, 'forbidden', 2],
          [nonParticipant, key(), even.id, request, 'not_found', 2],
          [a, key(), randomUUID(), request, 'not_found', 2],
          [a, key(), even.id, { expectedVersion: '1' }, 'invalid_version', 2],
          [a, key(), even.id, { expectedVersion: evenVersion - 1 }, 'stale_round', 2],
          [a, key(), round.id, { expectedVersion: version }, 'invalid_round_state', 2],
        ] as const) await trace(count, 'force-complete', () => assert.rejects(roundCommand(actor, ticket, id, 'force-complete', input, () => assert.fail('rejection must not publish')),
          (error: { code: string }) => error.code === expected))
        const unfinalized = await createRound(a, uuidV7(), group.id, { ...body, participantIds: [a.userId, b.userId] })
        const saved = await saveExpense(a, key(), unfinalized.id, { ...expenseBody, amount: '3', expectedVersion: 1 })
        const confirmed = await roundCommand(a, key(), unfinalized.id, 'confirm', { expectedVersion: saved.version })
        const locked = await roundCommand(a, key(), unfinalized.id, 'send', { expectedVersion: confirmed.version })
        await trace(2, 'force-complete', () => assert.rejects(roundCommand(a, key(), unfinalized.id, 'force-complete', { expectedVersion: locked.version }),
          (error: { code: string }) => error.code === 'invalid_round_state'))
        const before = await getSettlement(a, even.id)
        const beforeRound = await getRound(a, even.id, new URLSearchParams())
        assert.equal(before.requiredCount - before.checkedCount, 1)
        const constraint = `force_complete_test_${key().replaceAll('-', '')}`
        await db.query(`ALTER TABLE mutation_requests ADD CONSTRAINT ${constraint} CHECK (request_key <> '${requestKey}') NOT VALID`)
        try {
          await trace(3, 'force-complete', () => assert.rejects(roundCommand(a, requestKey, even.id, 'force-complete', request, () => assert.fail('failed save must not publish')),
            (error: { code: string }) => error.code === '23514'))
          assert.deepEqual(await getSettlement(a, even.id), before)
          assert.deepEqual(await getRound(a, even.id, new URLSearchParams()), beforeRound)
          assert.equal((await db.query('SELECT 1 FROM mutation_requests WHERE request_key=$1', [requestKey])).rowCount, 0)
        } finally { await db.query(`ALTER TABLE mutation_requests DROP CONSTRAINT ${constraint}`) }
        const result = await trace(3, 'force-complete', () => roundCommand(a, requestKey, even.id, 'force-complete', request, audience => {
          assert.equal(audience.groupId, group.id)
          assert.deepEqual(new Set(audience.userIds), new Set([a.userId, b.userId]))
        }))
        assert.equal(result.status, 'COMPLETED')
        assert.equal(result.version, evenVersion + 1)
        const after = await getSettlement(a, even.id)
        assert.notEqual((await getRound(a, even.id, new URLSearchParams())).completedAt, null)
        assert.deepEqual(after.confirmations, before.confirmations)
        assert.deepEqual(after.incoming, before.incoming)
        assert.deepEqual(after.outgoing, before.outgoing)
        assert.deepEqual(await trace(2, 'force-complete', () => roundCommand(a, requestKey, even.id, 'force-complete', request, () => assert.fail('replay must not publish'))), result)
        await trace(2, 'force-complete', () => assert.rejects(roundCommand(a, requestKey, even.id, 'force-complete', { expectedVersion: evenVersion + 1 }),
          (error: { code: string }) => error.code === 'idempotency_conflict'))
        await trace(2, 'force-complete', () => assert.rejects(roundCommand(a, key(), even.id, 'force-complete', { expectedVersion: result.version }),
          (error: { code: string }) => error.code === 'invalid_round_state'))
      })
      statements = []
      await assert.rejects(saveExpense(a, key(), even.id, { ...expenseBody, expectedVersion: evenVersion }), (error: { code: string }) => error.code === 'invalid_round_state')
      assert.equal(statements.length, 5)
      assert.equal(statements.at(-1), 'ROLLBACK')
    } finally { logger.mock.restore() }
  } finally {
    if (previous === undefined) delete process.env.DB_QUERY_LOG
    else process.env.DB_QUERY_LOG = previous
    await db.end()
  }
})
