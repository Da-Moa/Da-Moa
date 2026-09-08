import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { readAccessToken, type AccessToken } from '../src/lib/auth.ts'
import { completeOnboarding, signInKakao, updateBankAccount, withdrawAccount } from '../src/lib/auth-store.ts'
import { createDatabaseClient } from '../src/lib/db.ts'
import { acceptInvite, createGroup, createInvite, getGroup, getInvite, listGroups } from '../src/lib/group-store.ts'
import { addReceipt, checkExclusion, createRound, deleteExpense, excludeMember, getReceipt, getRound, getSettlement, listRounds, removeReceipt, roundCommand, saveExpense } from '../src/lib/round-store.ts'
import type { MutationResult } from '../src/lib/domain-types.ts'
import { applyMigrations } from './migrations.mjs'

const testUrl = process.env.TEST_DATABASE_URL
if (!testUrl || !new URL(testUrl).pathname.includes('test')) throw new Error('TEST_DATABASE_URL must name an isolated test database')
process.env.DATABASE_URL = testUrl
process.env.AUTH_JWT_SECRET ||= 'integration-only-not-a-production-secret-0123456789'
const key = () => randomUUID()
const query = () => new URLSearchParams()
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4WQAAAAASUVORK5CYII=', 'base64')

async function member(name: string): Promise<AccessToken> {
  const session = await signInKakao(`settlement-test:${key()}`, { displayName: name, email: null, profileImageUrl: null })
  const full = await completeOnboarding(readAccessToken(session.accessToken), { bankName: `${name}은행`, accountHolder: name, accountNumber: '00123456789' })
  return readAccessToken(full.accessToken)!
}

test('settlement lifecycle, permissions, privacy, exact money, idempotency and database races', async t => {
  const client = createDatabaseClient(testUrl)
  await client.connect()
  try {
    await applyMigrations(client)
    const a = await member('A'), b = await member('B'), c = await member('C'), d = await member('D'), outsider = await member('외부인')
    const people = [a, b, c, d]
    const g = await createGroup(a, key(), { name: '정산 통합 검증' })
    const inviteKey = key()
    const invite = await createInvite(a, inviteKey, g.id, {})
    const token = invite.sharePath!.split('/').at(-1)!
    for (const person of people.slice(1)) await acceptInvite(person, key(), token)
    const get = (id: string, actor = a) => getRound(actor, id, query())
    const command = async (id: string, action: string, actor = a) => roundCommand(actor, key(), id, action, { expectedVersion: (await get(id, actor)).version })
    const expense = async (id: string, actor: AccessToken, payerId: string, amount: string, participantIds?: string[]) => saveExpense(actor, key(), id, {
      description: '검증 지출', amount, payerId, splitMode: participantIds ? 'SELECTED' : 'ALL',
      ...(participantIds ? { participantIds } : {}), expectedVersion: (await get(id, actor)).version,
    })
    const round = async (members = [a, b, c]) => createRound(a, key(), g.id, { name: '검증 회차', currency: 'KRW', participantIds: members.map(m => m.userId) })

    await t.test('explicit invites and membership do not auto-add new rounds; response loss has a recoverable invite flow', async () => {
      assert.equal('currency' in (await getGroup(a, g.id)), false)
      assert.equal((await getInvite(b, token)).isMember, true)
      assert.equal('currency' in (await getInvite(b, token)), false)
      await acceptInvite(b, key(), token)
      assert.equal((await getGroup(a, g.id)).members.length, 4)
      const replay = await createInvite(a, inviteKey, g.id, {})
      assert.equal(replay.inviteId, invite.inviteId)
      assert.equal(replay.linkUnavailable, true)
      assert.equal(replay.sharePath, undefined)
      const replacement = await createInvite(a, key(), g.id, { replaceInviteId: invite.inviteId })
      await assert.rejects(getInvite(b, token), code('not_found'))
      assert.ok(replacement.sharePath)
      await assert.rejects(createGroup(a, key(), { name: 'x'.repeat(101) }), code('invalid_input'))
      await assert.rejects(createRound(a, key(), g.id, { name: '한 명', currency: 'KRW', participantIds: [a.userId] }), code('minimum_participants'))
      await assert.rejects(createRound(b, key(), g.id, { name: '권한 없음', currency: 'KRW', participantIds: [a.userId, b.userId] }), code('forbidden'))
      await assert.rejects(createRound(a, key(), g.id, { name: '외부인', currency: 'KRW', participantIds: [a.userId, outsider.userId] }), code('invalid_participants'))
    })

    await t.test('empty rounds, author/owner edits, partial edits and immutable completed data', async () => {
      const r = await round()
      await assert.rejects(command(r.id, 'confirm'), code('empty_expenses'))
      const saved = await expense(r.id, c, b.userId, '6000')
      const first = await get(r.id)
      const update = { description: '생성자가 수정', expectedVersion: first.version }
      await assert.rejects(saveExpense(b, key(), r.id, update, saved.id), code('forbidden'))
      await assert.rejects(saveExpense(a, key(), r.id, { ...update, description: null }, saved.id), code('invalid_input'))
      await saveExpense(a, key(), r.id, update, saved.id)
      const changed = await get(r.id)
      assert.equal(changed.expenses[0].authorId, c.userId)
      assert.equal(changed.expenses[0].payerId, b.userId)
      await assert.rejects(get(r.id, outsider), code('not_found'))
      await command(r.id, 'confirm')
      await assert.rejects(deleteExpense(a, key(), r.id, saved.id, { expectedVersion: (await get(r.id)).version }), code('invalid_round_state'))
      await command(r.id, 'reopen')
      await command(r.id, 'confirm')
      await command(r.id, 'send')
      const sb = await getSettlement(b, r.id), sa = await getSettlement(a, r.id), sc = await getSettlement(c, r.id)
      assert.equal(sb.balanceMinor, '-4000')
      assert.equal(sa.balanceMinor, '2000')
      assert.equal(sc.balanceMinor, '2000')
      assert.equal(sa.outgoing[0].receiverId, b.userId)
      assert.equal(sa.outgoing[0].amountMinor, '2000')
      assert.equal(sb.incoming.length, 2)
      assert.equal(sb.outgoing.length, 0)
      assert.equal(JSON.stringify(sa).includes('D은행'), false)
      assert.deepEqual((await get(r.id)).transfers, [
        { senderId: a.userId, receiverId: b.userId, amountMinor: '2000' },
        { senderId: c.userId, receiverId: b.userId, amountMinor: '2000' },
      ].sort((left, right) => left.senderId.localeCompare(right.senderId)))
      await command(r.id, 'complete')
      for (const action of ['reopen', 'cancel', 'confirm', 'send']) await assert.rejects(command(r.id, action), code('invalid_round_state'))
      await updateBankAccount(b, key(), { bankName: '최신 은행', accountNumber: '00009999', accountHolder: 'B 최신' })
      const newest = await getSettlement(a, r.id)
      assert.equal(newest.outgoing[0].account?.accountNumber, '00009999')
      assert.equal(newest.outgoing[0].amountMinor, '2000')
      assert.equal((await get(r.id)).expenses[0].amountMinor, '6000')
    })

    await t.test('payer outside selected burden retains all receivables, including after exclusion and group departure', async () => {
      const r = await round([a, b, c, d])
      await expense(r.id, c, b.userId, '6000', [a.userId, c.userId])
      const check = await checkExclusion(a, r.id, b.userId)
      assert.equal(check.allowed, true)
      await excludeMember(a, key(), r.id, b.userId, { expectedVersion: (await get(r.id)).version })
      assert.equal((await getGroup(a, g.id)).members.some(m => m.userId === b.userId), false)
      assert.equal((await get(r.id, b)).members.find(m => m.userId === b.userId)?.excludedAt !== null, true)
      await assert.rejects(withdrawAccount(b), code('unfinished_rounds'))
      await command(r.id, 'confirm'); await command(r.id, 'send')
      const result = await getSettlement(b, r.id)
      assert.equal(result.balanceMinor, '-6000')
      assert.deepEqual(result.incoming.map(x => x.amountMinor), ['3000', '3000'])
      await command(r.id, 'complete')
      assert.equal((await listRounds(b, query())).items.some(x => x.id === r.id), true)
      const reinvite = await createInvite(a, key(), g.id, {})
      await acceptInvite(b, key(), reinvite.sharePath!.split('/').at(-1)!)
    })

    await t.test('creator, payer-burden and selected burden exclusions block atomically; ALL recalculates', async () => {
      const r = await round([a, b, c, d])
      const e1 = await expense(r.id, a, b.userId, '6000')
      const e2 = await expense(r.id, a, a.userId, '3000', [c.userId, d.userId])
      for (const target of [a.userId, b.userId, c.userId]) {
        const before = await get(r.id)
        await assert.rejects(excludeMember(a, key(), r.id, target, { expectedVersion: before.version }), code('member_exclusion_blocked'))
        assert.deepEqual(await get(r.id), before)
      }
      assert.equal((await checkExclusion(a, r.id, c.userId)).expenses[0].id, e2.id)
      await deleteExpense(a, key(), r.id, e2.id, { expectedVersion: (await get(r.id)).version })
      await excludeMember(a, key(), r.id, c.userId, { expectedVersion: (await get(r.id)).version })
      const after = await get(r.id)
      assert.equal(after.expenses.find(e => e.id === e1.id)!.participantIds.length, 3)
      assert.equal(after.expenses[0].participantIds.includes(c.userId), false)
      await command(r.id, 'confirm'); await command(r.id, 'send'); await command(r.id, 'complete')
      const reinvite = await createInvite(a, key(), g.id, {})
      await acceptInvite(c, key(), reinvite.sharePath!.split('/').at(-1)!)
      const two = await round([a, c])
      await assert.rejects(excludeMember(a, key(), two.id, c.userId, { expectedVersion: 1 }), code('minimum_participants'))
      await command(two.id, 'cancel')
    })

    await t.test('receipt storage, authorization, failed upload preservation and hard-cancel cascade', async () => {
      const r = await round()
      const e = await expense(r.id, b, b.userId, '10')
      await assert.rejects(addReceipt(c, key(), r.id, e.id, e.version!, png, 'image/png'), code('forbidden'))
      await assert.rejects(addReceipt(b, key(), r.id, e.id, e.version!, Buffer.from('<svg/>'), 'image/svg+xml'), code('unsupported_receipt_type'))
      const uploadKey = key()
      const receipt = await addReceipt(b, uploadKey, r.id, e.id, e.version!, png, 'image/png')
      assert.deepEqual(Buffer.from((await getReceipt(a, receipt.id)).content), png)
      assert.equal((await addReceipt(b, uploadKey, r.id, e.id, e.version!, png, 'image/png')).id, receipt.id)
      await assert.rejects(getReceipt(outsider, receipt.id), code('not_found'))
      await command(r.id, 'confirm')
      await assert.rejects(addReceipt(b, key(), r.id, e.id, (await get(r.id)).version, png, 'image/png'), code('invalid_round_state'))
      await command(r.id, 'reopen')
      await removeReceipt(a, key(), r.id, e.id, receipt.id, { expectedVersion: (await get(r.id)).version })
      await assert.rejects(getReceipt(a, receipt.id), code('not_found'))
      const keep = await addReceipt(b, key(), r.id, e.id, (await get(r.id)).version, png, 'image/png')
      const cancelKey = key(), payload = { expectedVersion: keep.version }
      await roundCommand(a, cancelKey, r.id, 'cancel', payload)
      assert.equal((await roundCommand(a, cancelKey, r.id, 'cancel', payload)).id, r.id)
      await assert.rejects(get(r.id), code('not_found'))
      assert.equal((await client.query('SELECT count(*)::int AS n FROM expense_receipts WHERE id=$1', [keep.id])).rows[0].n, 0)
    })

    await t.test('one random draw, deferred finalization, idempotency and rollback after share writes', async () => {
      const r = await round()
      const submission = key(), body = { description: '나머지', amount: '10000', payerId: b.userId, splitMode: 'ALL', expectedVersion: 1 }
      const e = await saveExpense(a, submission, r.id, body)
      const recording = await get(r.id)
      assert.equal(recording.expenses[0].baseShareMinor, '3333')
      assert.equal(recording.expenses[0].remainderUnits, 1)
      assert.ok(recording.expenses[0].shares.every(s => s.amountMinor === null))
      assert.equal((await saveExpense(a, submission, r.id, body)).id, e.id)
      await assert.rejects(saveExpense(a, submission, r.id, { ...body, amount: '10001' }), code('idempotency_conflict'))
      await command(r.id, 'confirm'); await command(r.id, 'send')
      const pending = await getSettlement(a, r.id)
      assert.equal(pending.finalized, false); assert.equal(pending.sharePath, null); assert.equal(pending.balanceMinor, null)
      await assert.rejects(command(r.id, 'complete'), code('invalid_round_state'))
      // Fail after final shares/balances have been written to prove the whole transaction rolls back.
      const suffix = key().replaceAll('-', ''), fn = `fail_${suffix}`, trigger = `trip_${suffix}`
      await client.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.round_id='${r.id}' THEN RAISE EXCEPTION 'integration failure'; END IF; RETURN NEW; END $$`)
      await client.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON settlement_transfers FOR EACH ROW EXECUTE FUNCTION ${fn}()`)
      const drawKey = key(), drawBody = { expectedVersion: pending.version }
      try {
        await assert.rejects(roundCommand(a, drawKey, r.id, 'draw', drawBody))
        assert.equal((await getSettlement(a, r.id)).finalized, false)
        assert.equal((await client.query('SELECT count(*)::int AS n FROM settlement_balances WHERE round_id=$1', [r.id])).rows[0].n, 0)
        assert.equal((await client.query('SELECT count(*)::int AS n FROM expense_shares WHERE round_id=$1 AND final_amount_minor IS NOT NULL', [r.id])).rows[0].n, 0)
        assert.equal((await client.query('SELECT count(*)::int AS n FROM mutation_requests WHERE request_key=$1', [drawKey])).rows[0].n, 0)
      } finally {
        await client.query(`DROP TRIGGER ${trigger} ON settlement_transfers`)
        await client.query(`DROP FUNCTION ${fn}()`)
      }
      const draws = await Promise.all([roundCommand(a, drawKey, r.id, 'draw', drawBody), roundCommand(a, key(), r.id, 'draw', drawBody)])
      assert.equal(draws[0].version, draws[1].version)
      const final = await get(r.id), shares = final.expenses[0].shares
      assert.equal(shares.reduce((total, s) => total + BigInt(s.amountMinor!), 0n), 10000n)
      assert.equal(shares.filter(s => s.receivedRemainder).length, 1)
      const before = await getSettlement(a, r.id)
      await roundCommand(a, drawKey, r.id, 'draw', drawBody)
      assert.deepEqual(await getSettlement(a, r.id), before)
      await command(r.id, 'complete')
    })

    await t.test('racing edits/confirm and cancel/confirm cannot both commit, snapshots and pages stay coherent', async () => {
      const r = await round()
      const e = await expense(r.id, a, a.userId, '6000')
      const results = await Promise.allSettled([
        saveExpense(a, key(), r.id, { description: '동시 수정', expectedVersion: e.version }, e.id),
        roundCommand(a, key(), r.id, 'confirm', { expectedVersion: e.version }),
      ])
      assert.equal(results.filter(x => x.status === 'fulfilled').length, 1)
      const current = await get(r.id)
      if (current.status === 'CONFIRMED') await command(r.id, 'reopen')
      const v = (await get(r.id)).version
      const cancelled = await Promise.allSettled([
        roundCommand(a, key(), r.id, 'cancel', { expectedVersion: v }),
        roundCommand(a, key(), r.id, 'confirm', { expectedVersion: v }),
      ])
      assert.equal(cancelled.filter(x => x.status === 'fulfilled').length, 1)
      if (cancelled[0].status === 'rejected') { await command(r.id, 'reopen'); await command(r.id, 'cancel') }
      const many = await round()
      for (let i = 0; i < 3; i++) await expense(many.id, a, a.userId, '10')
      const first = await getRound(a, many.id, new URLSearchParams('limit=2'))
      const second = await getRound(a, many.id, new URLSearchParams({ limit: '2', cursor: first.expensesNextCursor! }))
      assert.equal(first.totalMinor, '30')
      assert.equal(new Set([...first.expenses, ...second.expenses].map(x => x.id)).size, 3)
      assert.equal((await getGroup(a, g.id)).members.length, 4)
      await command(many.id, 'cancel')
    })

    await t.test('one group has independent immutable round currencies, exact USD cents and no cross-round offset', async () => {
      const participants = [a.userId, b.userId]
      await assert.rejects(createGroup(a, key(), { name: '모임 통화 없음', currency: 'KRW' }), code('invalid_input'))
      for (const currency of [undefined, null, '', 'EUR', 'usd']) {
        await assert.rejects(createRound(a, key(), g.id, { name: '잘못된 통화', participantIds: participants, ...(currency === undefined ? {} : { currency }) }), code('unsupported_currency'))
      }
      const currencies = ['KRW', 'USD', 'JPY'] as const
      const rounds = await Promise.all(currencies.map(currency => createRound(a, key(), g.id, { name: `${currency} 회차`, currency, participantIds: participants })))
      const settled: { id: string; currency: string; balanceMinor: string }[] = []
      for (const [index, currency] of currencies.entries()) {
        const r = rounds[index]
        const amount = currency === 'USD' ? '9007199254740993.01' : '9007199254740993'
        const e = await expense(r.id, a, b.userId, amount)
        assert.equal((await get(r.id)).groupId, g.id)
        assert.equal((await get(r.id)).currency, currency)
        assert.equal((await get(r.id)).expenses[0].amountMinor, currency === 'USD' ? '900719925474099301' : '9007199254740993')
        await assert.rejects(saveExpense(a, key(), r.id, { amount: currency === 'USD' ? '1.001' : '1.5', expectedVersion: e.version }, e.id), code('invalid_amount'))
        await assert.rejects(saveExpense(a, key(), r.id, { currency: 'KRW', expectedVersion: e.version }, e.id), code('invalid_input'))
        await command(r.id, 'confirm')
        await command(r.id, 'reopen')
        const reopened = await get(r.id)
        assert.equal(reopened.currency, currency)
        await assert.rejects(roundCommand(a, key(), r.id, 'confirm', { expectedVersion: reopened.version, currency: 'USD' }), code('invalid_input'))
        assert.deepEqual(await get(r.id), reopened)
        await command(r.id, 'confirm'); await command(r.id, 'send'); await command(r.id, 'draw')
        const s = await getSettlement(a, r.id)
        assert.equal(s.currency, currency)
        assert.equal('account' in s.outgoing[0], currency === 'KRW')
        assert.ok(s.balanceMinor)
        settled.push({ id: r.id, currency, balanceMinor: s.balanceMinor })
        await command(r.id, 'complete')
        await assert.rejects(saveExpense(a, key(), r.id, { amount: '2', expectedVersion: (await get(r.id)).version }, e.id), code('invalid_round_state'))
      }
      for (const previous of settled) {
        const still = await getSettlement(a, previous.id)
        assert.equal(still.currency, previous.currency)
        assert.equal(still.balanceMinor, previous.balanceMinor, 'later rounds must not offset this round')
      }
      assert.equal('currency' in (await getGroup(a, g.id)), false)
      assert.equal((await listGroups(outsider, query())).items.length, 0)
    })
  } finally { await client.end() }
})
