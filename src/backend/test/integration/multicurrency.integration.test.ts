import { before } from 'node:test'
import { getPrismaClient } from '../domainTestSupport';
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { readAccessToken } from '../../global/auth/native.ts'
import { uuidV7 } from '../../../shared/uuid.ts'
import { createDatabaseClient } from '../../global/database/db.ts'
import { signInKakao } from '../domainTestSupport';
import { acceptInvite, createGroup, createInvite } from '../domainTestSupport';
import { createRound, deleteExpense, getRound, getSettlement, listRounds, roundCommand, saveExpense, setSettlementCheck } from '../domainTestSupport';
import type { Currency, ExpenseRequestDTO } from '../../../shared/domain/settle/index.ts'
import { applyMigrations } from '../../../../scripts/migrations.mjs'
import { completeTestOnboarding } from './bankTestSupport.ts'

const testUrl = process.env.TEST_DATABASE_URL
if (!testUrl || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(testUrl).hostname) || !new URL(testUrl).pathname.includes('test')) throw new Error('TEST_DATABASE_URL must name an isolated local test database')
process.env.DATABASE_URL = testUrl
process.env.AUTH_JWT_SECRET ||= 'multicurrency-test-secret-at-least-32-characters'
const code = (expected: string) => (error: unknown) => (error as { code: string }).code === expected

async function member(name: string) {
  const signup = await signInKakao(`multicurrency:${randomUUID()}`, { displayName: name, email: null, profileImageUrl: null })
  const session = await completeTestOnboarding(readAccessToken(signup.accessToken), { bankName: '검증은행', accountNumber: '12340312345678', accountHolder: name })
  return readAccessToken(session.accessToken)!
}

test('expense currencies enforce five slots, exact per-currency totals and independent receipt confirmation', async t => {
  const db = createDatabaseClient(testUrl!)
  await db.connect()
  try {
    await applyMigrations(db)
    const a = await member('통화 A'), b = await member('통화 B')
    const group = await createGroup(a, uuidV7(), { name: '복수 통화 검증' })
    const invite = await createInvite(a, randomUUID(), group.id, {})
    await acceptInvite(b, randomUUID(), invite.sharePath!.split('/').at(-1)!)
    const get = (id: string) => getRound(a, id, new URLSearchParams())
    const round = () => createRound(a, uuidV7(), group.id, { name: '복수 통화 회차', participantIds: [a.userId, b.userId] })
    const add = async (id: string, currency: Currency, amount = '10') => saveExpense(a, randomUUID(), id, { currency, amount, description: currency, payerId: b.userId, splitMode: 'ALL', expectedVersion: (await get(id)).version })
    const command = async (id: string, action: string) => roundCommand(a, randomUUID(), id, action, { expectedVersion: (await get(id)).version })

    await t.test('creation rejects round currency; missing and unsupported expense currency fail before writes', async () => {
      await assert.rejects(createRound(a, uuidV7(), group.id, { name: '금지 통화', currency: 'USD', participantIds: [a.userId, b.userId] }), code('invalid_input'))
      const r = await round()
      for (const currency of [undefined, null, 'usd', 'XXX', 'constructor']) {
        await assert.rejects(saveExpense(a, randomUUID(), r.id, { description: '검증', amount: '10', payerId: b.userId, splitMode: 'ALL', expectedVersion: 1, ...(currency === undefined ? {} : { currency }) }), code('unsupported_currency'))
      }
      assert.deepEqual((await get(r.id)).totals, [])
      assert.equal((await get(r.id)).version, 1)
      await command(r.id, 'cancel')
    })

    await t.test('sixth currency rejected; editing the last old expense frees its slot; deletion also frees a slot', async () => {
      const r = await round(), expenses = []
      for (const currency of ['KRW', 'JPY', 'USD', 'EUR', 'CNY'] as const) expenses.push(await add(r.id, currency))
      await assert.rejects(add(r.id, 'THB'), code('round_currency_limit_exceeded'))
      const duplicate = await add(r.id, 'KRW', '20')
      await assert.rejects(saveExpense(a, randomUUID(), r.id, { currency: 'THB', amount: '1.23', expectedVersion: (await get(r.id)).version }, expenses[0].id), code('round_currency_limit_exceeded'))
      await assert.rejects(saveExpense(a, randomUUID(), r.id, { currency: 'THB', expectedVersion: (await get(r.id)).version }, expenses[1].id), code('invalid_amount'))
      const changeKey = randomUUID(), body = { currency: 'THB' as const, amount: '1.23', expectedVersion: (await get(r.id)).version }
      const changed = await saveExpense(a, changeKey, r.id, body, expenses[1].id)
      assert.deepEqual(await saveExpense(a, changeKey, r.id, body, expenses[1].id), changed)
      const detail = await get(r.id)
      assert.equal(detail.totals.length, 5)
      assert.equal(detail.totals.find(total => total.currency === 'THB')?.totalMinor, '123')
      assert.equal(detail.totals.find(total => total.currency === 'KRW')?.totalMinor, '30')
      assert.ok(!detail.totals.some(total => total.currency === 'JPY'))
      assert.deepEqual((await listRounds(a, new URLSearchParams(), group.id)).items.find(item => item.id === r.id)?.totals, detail.totals)
      assert.deepEqual((await getRound(a, r.id, new URLSearchParams({ limit: '1' }))).totals, detail.totals)
      await deleteExpense(a, randomUUID(), r.id, expenses[1].id, { expectedVersion: detail.version })
      await add(r.id, 'JPY')
      assert.equal((await get(r.id)).totals.length, 5)
      await assert.rejects(saveExpense(a, randomUUID(), r.id, { currency: 'JPY', amount: '1.01', expectedVersion: (await get(r.id)).version }, duplicate.id), code('invalid_amount'))
    })

    await t.test('concurrent fifth/sixth currency additions and edits have one version winner', async () => {
      for (const editing of [false, true]) {
        const r = await round()
        for (const currency of ['KRW', 'JPY', 'USD', 'EUR'] as const) await add(r.id, currency)
        const original = await add(r.id, 'KRW')
        const expectedVersion = (await get(r.id)).version
        const outcomes = await Promise.allSettled((['CNY', 'THB'] as const).map(currency => saveExpense(a, randomUUID(), r.id, { currency, amount: '10', description: currency, payerId: b.userId, splitMode: 'ALL', expectedVersion }, editing ? original.id : undefined)))
        assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1)
        const rejected = outcomes.find(result => result.status === 'rejected') as PromiseRejectedResult
        assert.ok(['stale_round', 'round_currency_limit_exceeded'].includes(rejected.reason.code))
        assert.equal((await get(r.id)).totals.length, 5)
      }
    })

    await t.test('currency changes require explicit custom amounts and retain author permissions', async () => {
      const r = await round()
      const expense = await saveExpense(a, randomUUID(), r.id, { currency: 'USD', amount: '0.30', description: '개별 부담', payerId: b.userId, splitMode: 'CUSTOM', customShares: [{ userId: a.userId, amount: '0.10' }, { userId: b.userId, amount: '0.20' }], expectedVersion: 1 })
      await assert.rejects(saveExpense(a, randomUUID(), r.id, { currency: 'JPY', amount: '30', expectedVersion: expense.version }, expense.id), code('invalid_amount'))
      const body: ExpenseRequestDTO = { currency: 'JPY', amount: '30', customShares: [{ userId: a.userId, amount: '10' }, { userId: b.userId, amount: '20' }], expectedVersion: expense.version! }
      await assert.rejects(saveExpense(b, randomUUID(), r.id, body, expense.id), code('forbidden'))
      await saveExpense(a, randomUUID(), r.id, body, expense.id)
      const saved = (await get(r.id)).expenses[0]
      assert.equal(saved.currency, 'JPY')
      assert.equal(saved.amountMinor, '30')
      assert.deepEqual(saved.shares.map(share => share.assignedAmountMinor).sort(), ['10', '20'])
      await saveExpense(a, randomUUID(), r.id, { currency: 'EUR', amount: '0.30', splitMode: 'ALL', expectedVersion: (await get(r.id)).version }, expense.id)
      assert.equal((await get(r.id)).expenses[0].currency, 'EUR')
    })

    for (const remainder of [false, true]) await t.test(`same sender/receiver confirmations are independent per currency; draw=${remainder}`, async () => {
      const r = await round()
      await add(r.id, 'KRW', remainder ? '1001' : '1000')
      await add(r.id, 'JPY', remainder ? '201' : '200')
      await add(r.id, 'USD', remainder ? '0.31' : '0.30')
      await command(r.id, 'confirm'); await command(r.id, 'send')
      if (remainder) {
        const locked = await get(r.id)
        assert.equal(locked.pendingRemainders.length, 3)
        await command(r.id, 'draw')
        const result = await get(r.id)
        await command(r.id, 'draw')
        assert.deepEqual((await get(r.id)).transfers, result.transfers, 'saved draw is never repeated')
      }
      const sender = await getSettlement(a, r.id), receiver = await getSettlement(b, r.id)
      assert.equal(sender.balances.length, 3)
      assert.equal(sender.outgoing.length, 3)
      assert.equal(receiver.incoming.length, 3)
      for (const transfer of sender.outgoing) assert.equal('account' in transfer, transfer.currency === 'KRW')
      await assert.rejects(setSettlementCheck(b, randomUUID(), r.id, { checked: true, expectedVersion: receiver.version, senderId: a.userId }), code('unsupported_currency'))
      await setSettlementCheck(b, randomUUID(), r.id, { checked: true, expectedVersion: receiver.version, senderId: a.userId, currency: 'JPY' })
      const partial = await getSettlement(b, r.id)
      assert.ok(partial.incoming.find(transfer => transfer.currency === 'JPY')!.receivedAt)
      assert.ok(partial.incoming.filter(transfer => transfer.currency !== 'JPY').every(transfer => transfer.receivedAt === null))
      assert.equal(partial.allChecked, false)
      assert.deepEqual((await getSettlement(a, r.id)).outgoing.map(transfer => transfer.currency), ['KRW', 'USD'])
      await assert.rejects(command(r.id, 'complete'), code('pending_settlement_checks'))
      await setSettlementCheck(b, randomUUID(), r.id, { checked: false, expectedVersion: receiver.version, senderId: a.userId, currency: 'JPY' })
      assert.equal((await getSettlement(a, r.id)).outgoing.length, 3)
      for (const currency of ['KRW', 'JPY', 'USD'] as const) await setSettlementCheck(b, randomUUID(), r.id, { checked: true, expectedVersion: receiver.version, senderId: a.userId, currency })
      assert.equal((await getSettlement(b, r.id)).allChecked, true)
      await command(r.id, 'complete')
      await assert.rejects(setSettlementCheck(b, randomUUID(), r.id, { checked: false, expectedVersion: (await get(r.id)).version, senderId: a.userId, currency: 'JPY' }), code('invalid_round_state'))
    })
  } finally { await db.end() }
})

before(async () => { await getPrismaClient(process.env.TEST_DATABASE_URL!) })
