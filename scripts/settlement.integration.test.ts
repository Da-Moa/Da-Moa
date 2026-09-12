import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import sharp from 'sharp'
import { readAccessToken, type AccessToken } from '../src/lib/auth.ts'
import { signInKakao, updateBankAccount as saveBankAccount, withdrawAccount } from '../src/lib/auth-store.ts'
import { getAccount } from '../src/lib/authorization.ts'
import { createDatabaseClient } from '../src/lib/db.ts'
import { acceptInvite, createGroup, createInvite, getGroup, getInvite, leaveGroup, listGroups } from '../src/lib/group-store.ts'
import { addReceipt, checkExclusion, createRound, deleteExpense, excludeMember, getReceipt, getRound, getSettlement, listRounds, removeReceipt, roundCommand, saveExpense, setSettlementCheck } from '../src/lib/round-store.ts'
import type { MutationResult } from '../src/lib/domain-types.ts'
import { applyMigrations } from './migrations.mjs'
import { completeTestOnboarding as completeOnboarding, updateTestBankAccount as updateBankAccount } from './openbanking-test-support.ts'

const testUrl = process.env.TEST_DATABASE_URL
if (!testUrl || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(testUrl).hostname) || !new URL(testUrl).pathname.toLowerCase().includes('test')) throw new Error('TEST_DATABASE_URL must name an isolated local test database')
process.env.DATABASE_URL = testUrl
process.env.AUTH_JWT_SECRET ||= 'integration-only-not-a-production-secret-0123456789'
const key = () => randomUUID()
const query = () => new URLSearchParams()
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected

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
      const group = await getGroup(a, g.id)
      assert.equal(group.members.length, 4)
      assert.equal(group.members[0].userId, a.userId)
      const replay = await createInvite(a, inviteKey, g.id, {})
      assert.equal(replay.inviteId, invite.inviteId)
      assert.equal(replay.linkUnavailable, true)
      assert.equal(replay.sharePath, undefined)
      const replacement = await createInvite(a, key(), g.id, { replaceInviteId: invite.inviteId })
      await assert.rejects(getInvite(b, token), code('not_found'))
      assert.ok(replacement.sharePath)
      await assert.rejects(createGroup(a, key(), { name: 'x'.repeat(101) }), code('invalid_input'))
      await assert.rejects(createRound(a, key(), g.id, { name: '한 명', currency: 'KRW', participantIds: [a.userId] }), code('minimum_participants'))
      await assert.rejects(createRound(b, key(), g.id, { name: '본인 누락', currency: 'KRW', participantIds: [a.userId, c.userId] }), code('minimum_participants'))
      await assert.rejects(createRound(a, key(), g.id, { name: '외부인', currency: 'KRW', participantIds: [a.userId, outsider.userId] }), code('invalid_participants'))
    })

    await t.test('round lists search group and round names with existing filters and cursors', async () => {
      const rounds = await Promise.all(['alpha 검색대상', 'beta 검색대상', 'gamma 검색대상'].map(name =>
        createRound(a, key(), g.id, { name, currency: 'KRW', participantIds: [a.userId, b.userId] })))
      const first = await listRounds(a, new URLSearchParams({ q: '검색대상', status: 'RECORDING', limit: '2' }), g.id)
      const second = await listRounds(a, new URLSearchParams({ q: '검색대상', status: 'RECORDING', limit: '2', cursor: first.nextCursor! }), g.id)
      assert.equal(first.items.length, 2)
      assert.equal(second.items.length, 1)
      assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 3)
      assert.deepEqual((await listRounds(a, new URLSearchParams({ q: ' ALPHA ' }), g.id)).items.map(item => item.id), [rounds[0].id])
      assert.equal((await listRounds(a, new URLSearchParams({ q: '정산 통합' }), g.id)).items.length, 3)
      assert.equal((await listRounds(a, new URLSearchParams({ q: '검색대상', status: 'COMPLETED' }), g.id)).items.length, 0)
      await assert.rejects(listRounds(a, new URLSearchParams({ q: '   ' }), g.id), code('invalid_input'))
      await assert.rejects(listRounds(a, new URLSearchParams({ q: 'x'.repeat(101) }), g.id), code('invalid_input'))
      for (const round of rounds) await command(round.id, 'cancel')
    })

    await t.test('any active member starts and manages a round they create', async () => {
      const withoutGroupOwner = await createRound(b, key(), g.id, { name: '모임 생성자 없는 회차', currency: 'KRW', participantIds: [b.userId, c.userId] })
      await assert.rejects(get(withoutGroupOwner.id, a), code('not_found'))
      await assert.rejects(leaveGroup(a, key(), g.id), code('unfinished_group_rounds'))
      await command(withoutGroupOwner.id, 'cancel', b)
      const ownerExclusion = await createRound(b, key(), g.id, { name: '모임 생성자 제외', currency: 'KRW', participantIds: [a.userId, b.userId, c.userId] })
      assert.equal((await checkExclusion(b, ownerExclusion.id, a.userId)).allowed, true)
      assert.equal((await checkExclusion(b, ownerExclusion.id, b.userId)).reason, 'round_creator_cannot_leave')
      await excludeMember(b, key(), ownerExclusion.id, a.userId, { expectedVersion: (await get(ownerExclusion.id, b)).version })
      const membership = (await client.query(`SELECT rm.excluded_at,gm.left_at FROM round_members rm
        JOIN rounds r ON r.id=rm.round_id
        JOIN group_members gm ON gm.group_id=r.group_id AND gm.user_id=rm.user_id
        WHERE rm.round_id=$1 AND rm.user_id=$2`, [ownerExclusion.id, a.userId])).rows[0]
      assert.notEqual(membership.excluded_at, null)
      assert.equal(membership.left_at, null)
      assert.equal((await getGroup(b, g.id)).members.some(member => member.userId === a.userId), true)
      const next = await createRound(b, key(), g.id, { name: '제외 후 다음 회차', currency: 'KRW', participantIds: [a.userId, b.userId] })
      await command(next.id, 'cancel', b)
      await command(ownerExclusion.id, 'cancel', b)
      const r = await createRound(b, key(), g.id, { name: 'B가 시작한 회차', currency: 'KRW', participantIds: [a.userId, b.userId, c.userId] })
      const starterView = await get(r.id, b), groupOwnerView = await get(r.id, a)
      assert.equal(starterView.creatorId, b.userId)
      assert.equal(starterView.groupCreatorId, a.userId)
      assert.equal(starterView.isCreator, true)
      assert.equal(groupOwnerView.isCreator, false)
      await assert.rejects(roundCommand(a, key(), r.id, 'cancel', { expectedVersion: groupOwnerView.version }), code('forbidden'))
      const saved = await expense(r.id, a, a.userId, '3000')
      await saveExpense(b, key(), r.id, { description: '회차 생성자가 수정', amount: '6000', expectedVersion: saved.version }, saved.id)
      assert.equal((await get(r.id, b)).expenses[0].authorId, a.userId)
      const byC = await expense(r.id, c, c.userId, '3000')
      await assert.rejects(saveExpense(a, key(), r.id, { description: '모임 생성자의 수정 시도', amount: '6000', expectedVersion: byC.version }, byC.id), code('forbidden'))
      const related = await checkExclusion(b, r.id, a.userId)
      assert.equal(related.reason, 'member_exclusion_blocked')
      assert.equal(related.expenses[0].id, saved.id)
      assert.equal((await checkExclusion(b, r.id, b.userId)).reason, 'round_creator_cannot_leave')
      await command(r.id, 'cancel', b)
    })

    await t.test('participants leave without unfinished participation and creators close groups after every round completes', async () => {
      const leaving = await createGroup(a, key(), { name: '나가기 검증' })
      const invitation = await createInvite(a, key(), leaving.id, {})
      const invitationToken = invitation.sharePath!.split('/').at(-1)!
      await acceptInvite(b, key(), invitationToken)
      const past = await createRound(a, key(), leaving.id, { name: '과거 회차', currency: 'KRW', participantIds: [a.userId, b.userId] })
      await assert.rejects(leaveGroup(b, key(), leaving.id), code('unfinished_rounds'))
      await assert.rejects(leaveGroup(a, key(), leaving.id), code('unfinished_group_rounds'))
      await saveExpense(a, key(), past.id, { description: '완료할 지출', amount: '2', payerId: a.userId, splitMode: 'ALL', expectedVersion: 1 })
      for (const action of ['confirm', 'send', 'force-complete']) await roundCommand(a, key(), past.id, action, { expectedVersion: (await getRound(a, past.id, query())).version })
      await leaveGroup(b, key(), leaving.id)
      await assert.rejects(getGroup(b, leaving.id), code('not_found'))
      assert.equal((await listGroups(b, query())).items.some(group => group.id === leaving.id), false)
      assert.equal((await getRound(b, past.id, query())).id, past.id)
      await leaveGroup(a, key(), leaving.id)
      await assert.rejects(getGroup(a, leaving.id), code('not_found'))
      assert.equal((await getRound(a, past.id, query())).groupName, '나가기 검증')
      await assert.rejects(getInvite(a, invitationToken), code('not_found'))

      const empty = await createGroup(c, key(), { name: '삭제할 빈 모임' })
      const emptyInvite = await createInvite(c, key(), empty.id, {})
      await acceptInvite(d, key(), emptyInvite.sharePath!.split('/').at(-1)!)
      const deletionKey = key()
      assert.equal((await leaveGroup(c, deletionKey, empty.id)).id, empty.id)
      assert.equal((await leaveGroup(c, deletionKey, empty.id)).id, empty.id)
      await assert.rejects(getGroup(c, empty.id), code('not_found'))
      await assert.rejects(getGroup(d, empty.id), code('not_found'))
      await assert.rejects(getInvite(d, emptyInvite.sharePath!.split('/').at(-1)!), code('not_found'))
    })

    await t.test('empty rounds, author/round-creator edits, partial edits and immutable completed data', async () => {
      const r = await round()
      await assert.rejects(command(r.id, 'confirm'), code('empty_expenses'))
      const saved = await expense(r.id, c, b.userId, '6000')
      const first = await get(r.id)
      assert.equal(first.pendingRemainderMinor, '0')
      assert.deepEqual(first.transfers, [{ senderId: a.userId, receiverId: b.userId, amountMinor: '2000' }])
      const update = { description: '생성자가 수정', amount: '9000', expectedVersion: first.version }
      await assert.rejects(saveExpense(b, key(), r.id, update, saved.id), code('forbidden'))
      await assert.rejects(saveExpense(a, key(), r.id, { ...update, description: null }, saved.id), code('invalid_input'))
      await saveExpense(a, key(), r.id, update, saved.id)
      const changed = await get(r.id)
      assert.equal(changed.expenses[0].authorId, c.userId)
      assert.equal(changed.expenses[0].payerId, b.userId)
      assert.deepEqual(changed.transfers, [{ senderId: a.userId, receiverId: b.userId, amountMinor: '3000' }])
      await assert.rejects(get(r.id, outsider), code('not_found'))
      await command(r.id, 'confirm')
      await assert.rejects(deleteExpense(a, key(), r.id, saved.id, { expectedVersion: (await get(r.id)).version }), code('invalid_round_state'))
      await command(r.id, 'reopen')
      await command(r.id, 'confirm')
      await command(r.id, 'send')
      const sb = await getSettlement(b, r.id), sa = await getSettlement(a, r.id), sc = await getSettlement(c, r.id)
      assert.equal(sb.balanceMinor, '-6000')
      assert.equal(sa.balanceMinor, '3000')
      assert.equal(sc.balanceMinor, '3000')
      assert.equal(sa.outgoing[0].receiverId, b.userId)
      assert.equal(sa.outgoing[0].amountMinor, '3000')
      assert.equal(typeof sa.outgoing[0].account?.verifiedAt, 'number')
      assert.equal(sb.incoming.length, 2)
      assert.equal(sb.outgoing.length, 0)
      assert.equal(JSON.stringify(sa).includes('D은행'), false)
      const detailA = await get(r.id), detailB = await get(r.id, b), detailC = await get(r.id, c)
      assert.deepEqual(detailA.transfers, [{ senderId: a.userId, receiverId: b.userId, amountMinor: '3000' }])
      assert.deepEqual(detailB.transfers, [
        { senderId: a.userId, receiverId: b.userId, amountMinor: '3000' },
        { senderId: c.userId, receiverId: b.userId, amountMinor: '3000' },
      ].sort((left, right) => left.senderId.localeCompare(right.senderId)))
      assert.deepEqual(detailC.transfers, [{ senderId: c.userId, receiverId: b.userId, amountMinor: '3000' }])
      for (const [viewer, detail] of [[a.userId, detailA], [b.userId, detailB], [c.userId, detailC]] as const) {
        assert.ok(detail.transfers.every(row => row.senderId === viewer || row.receiverId === viewer))
      }
      await command(r.id, 'force-complete')
      for (const action of ['reopen', 'cancel', 'confirm', 'send']) await assert.rejects(command(r.id, action), code('invalid_round_state'))
      await updateBankAccount(b, key(), { bankName: '최신 은행', accountNumber: '00009999', accountHolder: 'B 최신' })
      const newest = await getSettlement(a, r.id)
      assert.equal(newest.outgoing[0].account?.accountNumber, '00009999')
      assert.equal(newest.outgoing[0].amountMinor, '3000')
      const current = await getAccount(b)
      await saveBankAccount(b, key(), { bankCode: '004', accountNumber: '00008888', accountHolder: 'B 최신', expectedBankVersion: current.bankVersion, verifyWithOpenBanking: false })
      const unverified = await getSettlement(a, r.id)
      assert.equal(unverified.outgoing[0].account?.accountNumber, '00008888')
      assert.equal(unverified.outgoing[0].account?.verifiedAt, null)
      assert.equal(unverified.outgoing[0].amountMinor, '3000')
      assert.equal((await get(r.id)).expenses[0].amountMinor, '9000')
    })

    await t.test('payer outside selected burden retains all receivables after round exclusion', async () => {
      const r = await round([a, b, c, d])
      await expense(r.id, c, b.userId, '6000', [a.userId, c.userId])
      const check = await checkExclusion(a, r.id, b.userId)
      assert.equal(check.allowed, true)
      await excludeMember(a, key(), r.id, b.userId, { expectedVersion: (await get(r.id)).version })
      assert.equal((await getGroup(a, g.id)).members.some(m => m.userId === b.userId), true)
      assert.equal((await get(r.id, b)).members.find(m => m.userId === b.userId)?.excludedAt !== null, true)
      await assert.rejects(withdrawAccount(b), code('unfinished_rounds'))
      await command(r.id, 'confirm'); await command(r.id, 'send')
      const result = await getSettlement(b, r.id)
      assert.equal(result.balanceMinor, '-6000')
      assert.deepEqual(result.incoming.map(x => x.amountMinor), ['3000', '3000'])
      assert.equal(result.checkRequired, true, 'an excluded payer with receivables must still confirm')
      assert.equal(result.requiredCount, 1)
      assert.deepEqual(result.confirmations.map(member => ({ userId: member.userId, checkedAt: member.checkedAt })), [{ userId: b.userId, checkedAt: null }])
      assert.ok(result.incoming.every(transfer => transfer.receivedAt === null))
      await assert.rejects(command(r.id, 'complete'), code('pending_settlement_checks'))
      const [first, second] = result.incoming
      const firstSender = first.senderId === a.userId ? a : c
      assert.equal((await getSettlement(firstSender, r.id)).outgoing.some(transfer => transfer.receiverId === b.userId), true)
      const firstCheck = await setSettlementCheck(b, key(), r.id, { expectedVersion: result.version, checked: true, senderId: first.senderId })
      assert.equal(firstCheck.version, result.version, 'checks must not bump the round version')
      const partial = await getSettlement(b, r.id)
      assert.notEqual(partial.incoming.find(transfer => transfer.senderId === first.senderId)?.receivedAt, null)
      assert.equal(partial.incoming.find(transfer => transfer.senderId === second.senderId)?.receivedAt, null)
      assert.equal(partial.confirmations[0].checkedAt, null, 'a receiver remains pending until every incoming transfer is checked')
      assert.equal((await getSettlement(firstSender, r.id)).outgoing.some(transfer => transfer.receiverId === b.userId), false)
      await setSettlementCheck(b, key(), r.id, { expectedVersion: result.version, checked: false, senderId: first.senderId })
      assert.equal((await getSettlement(firstSender, r.id)).outgoing.some(transfer => transfer.receiverId === b.userId), true)
      await setSettlementCheck(b, key(), r.id, { expectedVersion: result.version, checked: true, senderId: first.senderId })
      await setSettlementCheck(b, key(), r.id, { expectedVersion: result.version, checked: true, senderId: second.senderId })
      const confirmed = await getSettlement(a, r.id)
      assert.equal(confirmed.checkedCount, 1)
      assert.equal(confirmed.allChecked, true)
      await command(r.id, 'complete')
      assert.ok((await getSettlement(a, r.id)).confirmations.every(member => member.checkedAt !== null), 'completed rounds preserve every check')
      assert.equal((await listRounds(b, query())).items.some(x => x.id === r.id), true)
    })

    await t.test('participants toggle their own check and only the creator can force completion', async () => {
      const r = await round([a, b, c])
      await expense(r.id, a, a.userId, '3000')
      await command(r.id, 'confirm'); await command(r.id, 'send')
      const initial = await getSettlement(a, r.id)
      assert.deepEqual({ checkedAt: initial.checkedAt, checkRequired: initial.checkRequired, checkedCount: initial.checkedCount, requiredCount: initial.requiredCount, allChecked: initial.allChecked },
        { checkedAt: null, checkRequired: true, checkedCount: 0, requiredCount: 1, allChecked: false })
      await assert.rejects(setSettlementCheck(outsider, key(), r.id, { expectedVersion: initial.version, checked: true }), code('not_found'))
      await assert.rejects(setSettlementCheck(a, key(), r.id, { expectedVersion: initial.version, checked: true, senderId: outsider.userId }), code('forbidden'))
      const requestKey = key()
      await setSettlementCheck(a, requestKey, r.id, { expectedVersion: initial.version, checked: true })
      const checkedAt = (await getSettlement(a, r.id)).checkedAt
      await setSettlementCheck(a, requestKey, r.id, { expectedVersion: initial.version, checked: true })
      await setSettlementCheck(a, key(), r.id, { expectedVersion: initial.version, checked: true })
      assert.equal((await getSettlement(a, r.id)).checkedAt, checkedAt, 'repeated checks must preserve the first timestamp')
      await setSettlementCheck(a, key(), r.id, { expectedVersion: initial.version, checked: false })
      assert.equal((await getSettlement(a, r.id)).checkedAt, null)
      await assert.rejects(roundCommand(b, key(), r.id, 'force-complete', { expectedVersion: initial.version }), code('forbidden'))
      await roundCommand(a, key(), r.id, 'force-complete', { expectedVersion: initial.version })
      await assert.rejects(setSettlementCheck(a, key(), r.id, { expectedVersion: initial.version + 1, checked: true }), code('invalid_round_state'))
      const forced = await getSettlement(a, r.id)
      assert.equal(forced.allChecked, false)
      assert.ok(forced.confirmations.every(member => member.checkedAt === null), 'forced completion preserves pending confirmations')

      const zero = await round([a, b])
      await expense(zero.id, a, a.userId, '100', [a.userId])
      await command(zero.id, 'confirm'); await command(zero.id, 'send')
      const noTransfers = await getSettlement(a, zero.id)
      assert.deepEqual({ requiredCount: noTransfers.requiredCount, allChecked: noTransfers.allChecked, confirmations: noTransfers.confirmations }, { requiredCount: 0, allChecked: true, confirmations: [] })
      await command(zero.id, 'complete')
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
      await command(r.id, 'confirm'); await command(r.id, 'send')
      const excludedSettlement = await getSettlement(c, r.id)
      assert.equal(excludedSettlement.checkRequired, false)
      assert.equal(excludedSettlement.requiredCount, 1)
      await assert.rejects(setSettlementCheck(c, key(), r.id, { expectedVersion: excludedSettlement.version, checked: true }), code('forbidden'))
      await command(r.id, 'force-complete')
      const two = await round([a, c])
      await assert.rejects(excludeMember(a, key(), two.id, c.userId, { expectedVersion: 1 }), code('minimum_participants'))
      await command(two.id, 'cancel')
    })

    await t.test('receipt storage, authorization, failed upload preservation and hard-cancel cascade', async () => {
      const r = await round()
      const e = await expense(r.id, b, b.userId, '10')
      const sources = [
        { mimeType: 'image/jpeg', content: await sharp({ create: { width: 2, height: 2, channels: 3, background: '#f33' } }).jpeg().toBuffer() },
        { mimeType: 'image/png', content: await sharp({ create: { width: 2, height: 2, channels: 3, background: '#3f3' } }).png().toBuffer() },
        { mimeType: 'image/webp', content: await sharp({ create: { width: 2, height: 2, channels: 3, background: '#33f' } }).webp().toBuffer() },
      ]
      await assert.rejects(addReceipt(c, key(), r.id, e.id, e.version!, Buffer.from('<svg/>'), 'image/svg+xml'), code('forbidden'))
      await assert.rejects(addReceipt(b, key(), r.id, e.id, e.version!, Buffer.from('<svg/>'), 'image/svg+xml'), code('unsupported_receipt_type'))
      await assert.rejects(addReceipt(b, key(), r.id, e.id, e.version!, sources[1].content, 'image/jpeg'), code('unsupported_receipt_type'))
      await assert.rejects(addReceipt(b, key(), r.id, e.id, e.version!, sources[0].content.subarray(0, -2), 'image/jpeg'), code('unsupported_receipt_type'))
      const uploaded: MutationResult[] = []
      for (const source of sources) {
        const expectedVersion = (await get(r.id)).version, uploadKey = key()
        const receipt = await addReceipt(b, uploadKey, r.id, e.id, expectedVersion, source.content, source.mimeType)
        const stored = await getReceipt(a, receipt.id)
        assert.equal(stored.mimeType, 'image/avif')
        assert.equal((await sharp(stored.content).metadata()).mediaType, 'image/avif')
        assert.notDeepEqual(Buffer.from(stored.content), source.content)
        const metadata = (await get(r.id)).expenses[0].receipts.find(item => item.id === receipt.id)
        assert.equal(metadata?.mimeType, 'image/avif')
        assert.equal(metadata?.byteSize, stored.content.length)
        assert.equal((await addReceipt(b, uploadKey, r.id, e.id, expectedVersion, source.content, source.mimeType)).id, receipt.id)
        uploaded.push(receipt)
      }
      const receipt = uploaded[1]
      await assert.rejects(getReceipt(outsider, receipt.id), code('not_found'))
      await command(r.id, 'confirm')
      await assert.rejects(addReceipt(b, key(), r.id, e.id, (await get(r.id)).version, sources[1].content, sources[1].mimeType), code('invalid_round_state'))
      await command(r.id, 'reopen')
      await removeReceipt(a, key(), r.id, e.id, receipt.id, { expectedVersion: (await get(r.id)).version })
      await assert.rejects(getReceipt(a, receipt.id), code('not_found'))
      const keep = await addReceipt(b, key(), r.id, e.id, (await get(r.id)).version, sources[1].content, sources[1].mimeType)
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
      assert.equal(pending.confirmations.length, 0, 'confirmation targets are derived only after transfers are finalized')
      assert.equal(pending.allChecked, true)
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
      await command(r.id, 'force-complete')
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
      assert.equal(first.pendingRemainderMinor, '3')
      assert.deepEqual(second.transfers, first.transfers)
      assert.deepEqual(first.transfers.map(row => row.amountMinor), ['9', '9'])
      assert.equal(new Set([...first.expenses, ...second.expenses].map(x => x.id)).size, 3)
      assert.equal((await getGroup(a, g.id)).members.length, 4)
      await command(many.id, 'cancel')
    })

    await t.test('expense and round total limits use each currency major unit and updates replace the old amount', async () => {
      for (const currency of ['KRW', 'JPY', 'USD'] as const) {
        const r = await createRound(a, key(), g.id, { name: `${currency} 금액 상한`, currency, participantIds: [a.userId, b.userId] })
        const maximum = currency === 'USD' ? '100000000.00' : '100000000'
        const overMaximum = currency === 'USD' ? '100000000.01' : '100000001'
        const belowMaximum = currency === 'USD' ? '99999999.99' : '99999999'
        const minimum = currency === 'USD' ? '0.01' : '1'
        const scale = currency === 'USD' ? 100n : 1n
        const saved = [await expense(r.id, a, a.userId, maximum)]

        await assert.rejects(expense(r.id, a, a.userId, overMaximum), code('expense_amount_limit_exceeded'))
        for (let index = 1; index < 10; index++) saved.push(await expense(r.id, a, a.userId, maximum))
        assert.equal((await get(r.id)).totalMinor, (1_000_000_000n * scale).toString())
        await assert.rejects(expense(r.id, a, a.userId, minimum), code('round_total_limit_exceeded'))

        await saveExpense(a, key(), r.id, { amount: belowMaximum, expectedVersion: (await get(r.id)).version }, saved[0].id)
        await expense(r.id, a, a.userId, minimum)
        const atLimit = await get(r.id)
        assert.equal(atLimit.totalMinor, (1_000_000_000n * scale).toString())
        await assert.rejects(
          saveExpense(a, key(), r.id, { amount: maximum, expectedVersion: atLimit.version }, saved[0].id),
          code('round_total_limit_exceeded'),
        )
        const unchanged = await get(r.id)
        assert.equal(unchanged.totalMinor, atLimit.totalMinor)
        assert.equal(unchanged.expenses.find(item => item.id === saved[0].id)?.amountMinor, (99_999_999n * scale + (currency === 'USD' ? 99n : 0n)).toString())
        await command(r.id, 'cancel')
      }
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
        const amount = currency === 'USD' ? '12345678.01' : '12345678'
        const e = await expense(r.id, a, b.userId, amount)
        assert.equal((await get(r.id)).groupId, g.id)
        assert.equal((await get(r.id)).currency, currency)
        assert.equal((await get(r.id)).expenses[0].amountMinor, currency === 'USD' ? '1234567801' : '12345678')
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
        await command(r.id, 'force-complete')
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

    await t.test('active Kakao profile images are shown and withdrawn profiles are masked', async () => {
      const subject = `settlement-profile:${key()}`
      const profileImageUrl = 'https://profiles.example.test/active.png'
      const signup = await signInKakao(subject, { displayName: '탈퇴 프로필', email: null, profileImageUrl })
      const registered = await completeOnboarding(readAccessToken(signup.accessToken), { bankName: '프로필은행', accountHolder: '탈퇴 프로필', accountNumber: '00123456789' })
      const departed = readAccessToken(registered.accessToken)!
      const profileGroup = await createGroup(a, key(), { name: '프로필 표시 검증' })
      const profileInvite = await createInvite(a, key(), profileGroup.id, {})
      await acceptInvite(departed, key(), profileInvite.sharePath!.split('/').at(-1)!)
      const r = await createRound(a, key(), profileGroup.id, { name: '프로필 회차', currency: 'KRW', participantIds: [a.userId, departed.userId] })
      await expense(r.id, a, departed.userId, '2000')
      await command(r.id, 'confirm'); await command(r.id, 'send'); await command(r.id, 'force-complete')

      assert.equal((await get(r.id)).members.find(member => member.userId === departed.userId)?.profileImageUrl, profileImageUrl)
      const activeSettlement = await getSettlement(a, r.id)
      assert.equal(activeSettlement.outgoing[0].profileImageUrl, profileImageUrl)
      assert.equal(activeSettlement.confirmations.find(member => member.userId === departed.userId)?.profileImageUrl, profileImageUrl)
      await withdrawAccount(departed)
      assert.equal((await get(r.id)).members.find(member => member.userId === departed.userId)?.profileImageUrl, null)
      const deletedSettlement = await getSettlement(a, r.id)
      assert.equal(deletedSettlement.outgoing[0].profileImageUrl, null)
      assert.equal(deletedSettlement.confirmations.find(member => member.userId === departed.userId)?.profileImageUrl, null)
      await signInKakao(subject, { displayName: '재가입 전 프로필', email: null, profileImageUrl: 'https://profiles.example.test/changed.png' })
      assert.equal((await getSettlement(a, r.id)).outgoing[0].profileImageUrl, null)
    })
  } finally { await client.end() }
})
