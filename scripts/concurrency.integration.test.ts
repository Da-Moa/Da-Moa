import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { before, test } from 'node:test'
import sharp from 'sharp'
import { currentTimestamp, readAccessToken, type AccessToken } from '../src/lib/auth.ts'
import { signInKakao, withdrawAccount } from '../src/lib/auth-store.ts'
import { createDatabaseClient } from '../src/lib/db.ts'
import { AppError } from '../src/lib/errors.ts'
import { acceptInvite, createGroup, createInvite, leaveGroup } from '../src/lib/group-store.ts'
import { addReceipt, createRound, getRound, getSettlement, roundCommand, saveExpense, setSettlementCheck } from '../src/lib/round-store.ts'
import { applyMigrations } from './migrations.mjs'
import { completeTestOnboarding as completeOnboarding } from './openbanking-test-support.ts'

const testUrl = process.env.TEST_DATABASE_URL
if (!testUrl || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(testUrl).hostname) || !new URL(testUrl).pathname.toLowerCase().includes('test')) throw new Error('TEST_DATABASE_URL must name an isolated local test database')
const applicationName = `settlement-concurrency-${randomUUID()}`
const runtimeUrl = new URL(testUrl)
runtimeUrl.searchParams.set('application_name', applicationName)
process.env.DATABASE_URL = runtimeUrl.toString()
process.env.AUTH_JWT_SECRET ||= 'integration-only-not-a-production-secret-0123456789'
const key = () => randomUUID()
const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } }).png().toBuffer()

async function member(): Promise<AccessToken> {
  const limited = await signInKakao(`concurrency-test:${key()}`, { displayName: '경합 검증 사용자', email: null, profileImageUrl: null })
  const full = await completeOnboarding(readAccessToken(limited.accessToken), { bankName: '테스트 은행', accountHolder: '경합 검증 사용자', accountNumber: '00012345678' })
  return readAccessToken(full.accessToken)!
}

async function group(join = true) {
  const owner = await member(), participant = await member()
  const group = await createGroup(owner, key(), { name: '경합 검증 모임' })
  const invitation = await createInvite(owner, key(), group.id, {})
  const token = invitation.sharePath!.split('/').at(-1)!
  if (join) await acceptInvite(participant, key(), token)
  return { owner, participant, groupId: group.id, token }
}

async function recordingRound() {
  const fixture = await group()
  const round = await createRound(fixture.owner, key(), fixture.groupId, { name: '경합 검증 회차', currency: 'KRW', participantIds: [fixture.owner.userId, fixture.participant.userId] })
  const expense = await saveExpense(fixture.participant, key(), round.id, { description: '경합 지출', amount: '3', payerId: fixture.owner.userId, splitMode: 'ALL', expectedVersion: round.version })
  return { ...fixture, roundId: round.id, expenseId: expense.id, version: expense.version! }
}

async function inspect<T>(work: (client: ReturnType<typeof createDatabaseClient>) => Promise<T>) {
  const client = createDatabaseClient(testUrl!)
  try { await client.connect(); return await work(client) } finally { await client.end() }
}

before(async () => { await inspect(client => applyMigrations(client)) })

test('reopen racing send commits exactly one state transition', async () => {
  const fixture = await recordingRound()
  const confirmed = await roundCommand(fixture.owner, key(), fixture.roundId, 'confirm', { expectedVersion: fixture.version })
  const outcomes = await Promise.allSettled([
    roundCommand(fixture.owner, key(), fixture.roundId, 'reopen', { expectedVersion: confirmed.version }),
    roundCommand(fixture.owner, key(), fixture.roundId, 'send', { expectedVersion: confirmed.version }),
  ])
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1)
  const failure = outcomes.find(outcome => outcome.status === 'rejected') as PromiseRejectedResult
  assert.ok(failure.reason instanceof AppError)
  assert.equal(failure.reason.code, 'stale_round')
  const current = await getRound(fixture.owner, fixture.roundId, new URLSearchParams())
  assert.equal(current.version, confirmed.version! + 1)
  if (outcomes[0].status === 'fulfilled') {
    assert.equal(current.status, 'RECORDING')
    assert.equal(current.finalizedAt, null)
    await roundCommand(fixture.owner, key(), fixture.roundId, 'cancel', { expectedVersion: current.version })
  } else {
    assert.equal(current.status, 'LOCKED')
    const drawn = await roundCommand(fixture.owner, key(), fixture.roundId, 'draw', { expectedVersion: current.version })
    await roundCommand(fixture.owner, key(), fixture.roundId, 'force-complete', { expectedVersion: drawn.version })
  }
})

test('settlement checks compose concurrently and normal/forced completion cannot both commit', async () => {
  const finalRound = async () => {
    const fixture = await recordingRound()
    const confirmed = await roundCommand(fixture.owner, key(), fixture.roundId, 'confirm', { expectedVersion: fixture.version })
    const locked = await roundCommand(fixture.owner, key(), fixture.roundId, 'send', { expectedVersion: confirmed.version })
    const finalized = await roundCommand(fixture.owner, key(), fixture.roundId, 'draw', { expectedVersion: locked.version })
    return { ...fixture, version: finalized.version! }
  }

  const simultaneous = await group()
  const third = await member()
  await acceptInvite(third, key(), simultaneous.token)
  const round = await createRound(simultaneous.owner, key(), simultaneous.groupId, { name: '복수 수취 경합', currency: 'KRW', participantIds: [simultaneous.owner.userId, simultaneous.participant.userId, third.userId] })
  const expense = await saveExpense(simultaneous.owner, key(), round.id, { description: '복수 송금', amount: '6', payerId: simultaneous.owner.userId, splitMode: 'ALL', expectedVersion: round.version })
  const confirmed = await roundCommand(simultaneous.owner, key(), round.id, 'confirm', { expectedVersion: expense.version })
  const locked = await roundCommand(simultaneous.owner, key(), round.id, 'send', { expectedVersion: confirmed.version })
  const incoming = (await getSettlement(simultaneous.owner, round.id)).incoming
  assert.equal(incoming.length, 2)
  const checks = await Promise.all(incoming.map(transfer => setSettlementCheck(simultaneous.owner, key(), round.id, {
    expectedVersion: locked.version, checked: true, senderId: transfer.senderId,
  })))
  assert.ok(checks.every(result => result.version === locked.version))
  const checked = await getSettlement(simultaneous.owner, round.id)
  assert.equal(checked.confirmations.length, 1)
  assert.ok(checked.incoming.every(transfer => transfer.receivedAt !== null))
  const completions = await Promise.allSettled([
    roundCommand(simultaneous.owner, key(), round.id, 'complete', { expectedVersion: locked.version }),
    roundCommand(simultaneous.owner, key(), round.id, 'force-complete', { expectedVersion: locked.version }),
  ])
  assert.equal(completions.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal((await getRound(simultaneous.owner, round.id, new URLSearchParams())).version, locked.version! + 1)

  const lastCheck = await finalRound()
  const race = await Promise.allSettled([
    setSettlementCheck(lastCheck.owner, key(), lastCheck.roundId, { expectedVersion: lastCheck.version, checked: true }),
    roundCommand(lastCheck.owner, key(), lastCheck.roundId, 'complete', { expectedVersion: lastCheck.version }),
  ])
  assert.equal(race[0].status, 'fulfilled')
  const current = await getSettlement(lastCheck.owner, lastCheck.roundId)
  assert.equal(current.allChecked, true)
  if (current.status === 'LOCKED') await roundCommand(lastCheck.owner, key(), lastCheck.roundId, 'complete', { expectedVersion: current.version })
})

test('round creation racing participant withdrawal never creates unfinished participation for a deleted member', async () => {
  const fixture = await group()
  const outcomes = await Promise.allSettled([
    createRound(fixture.owner, key(), fixture.groupId, { name: '탈퇴와 경합', currency: 'KRW', participantIds: [fixture.owner.userId, fixture.participant.userId] }),
    withdrawAccount(fixture.participant),
  ])
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1)
  const state = await inspect(async client => (await client.query(`
    SELECT u.deleted_at,
      (SELECT COUNT(*)::int FROM round_members m JOIN rounds r ON r.id=m.round_id WHERE m.user_id=u.id AND r.status<>'COMPLETED') AS unfinished,
      (SELECT COUNT(*)::int FROM refresh_sessions s WHERE s.user_id=u.id AND s.purpose='app' AND s.revoked_at IS NULL AND s.expires_at>$2) AS sessions
    FROM users u WHERE u.id=$1`, [fixture.participant.userId, currentTimestamp()])).rows[0])
  if (outcomes[0].status === 'fulfilled') {
    assert.equal(state.deleted_at, null)
    assert.equal(state.unfinished, 1)
    assert.ok(outcomes[1].status === 'rejected' && outcomes[1].reason instanceof AppError)
    assert.equal(outcomes[1].reason.code, 'unfinished_rounds')
    await roundCommand(fixture.owner, key(), outcomes[0].value.id, 'cancel', { expectedVersion: 1 })
  } else {
    assert.ok(outcomes[0].reason instanceof AppError)
    assert.equal(outcomes[0].reason.code, 'invalid_participants')
    assert.notEqual(state.deleted_at, null)
    assert.equal(state.unfinished, 0)
    assert.equal(state.sessions, 0)
  }
})

test('invite acceptance racing withdrawal leaves no active membership or app session on a deleted user', async () => {
  const fixture = await group(false)
  const outcomes = await Promise.allSettled([
    acceptInvite(fixture.participant, key(), fixture.token),
    withdrawAccount(fixture.participant),
  ])
  assert.equal(outcomes[1].status, 'fulfilled')
  if (outcomes[0].status === 'rejected') {
    assert.ok(outcomes[0].reason instanceof AppError)
    assert.equal(outcomes[0].reason.code, 'unauthorized')
  }
  const state = await inspect(async client => (await client.query(`
    SELECT u.deleted_at,
      (SELECT COUNT(*)::int FROM group_members m WHERE m.user_id=u.id AND m.left_at IS NULL) AS memberships,
      (SELECT COUNT(*)::int FROM refresh_sessions s WHERE s.user_id=u.id AND s.purpose='app' AND s.revoked_at IS NULL AND s.expires_at>$2) AS sessions
    FROM users u WHERE u.id=$1`, [fixture.participant.userId, currentTimestamp()])).rows[0])
  assert.notEqual(state.deleted_at, null)
  assert.equal(state.memberships, 0)
  assert.equal(state.sessions, 0)
})

test('simultaneous invite acceptance never exceeds ten active group members', async () => {
  const fixture = await group(false)
  const existing: AccessToken[] = []
  for (let index = 0; index < 8; index++) existing.push(await member())
  for (const person of existing) await acceptInvite(person, key(), fixture.token)
  const candidates = [fixture.participant, await member()]
  const outcomes = await Promise.allSettled(candidates.map(person => acceptInvite(person, key(), fixture.token)))
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1)
  const failure = outcomes.find(outcome => outcome.status === 'rejected') as PromiseRejectedResult
  assert.ok(failure.reason instanceof AppError)
  assert.equal(failure.reason.code, 'group_member_limit_exceeded')
  const winner = candidates[outcomes.findIndex(outcome => outcome.status === 'fulfilled')]!
  const loser = candidates[outcomes.findIndex(outcome => outcome.status === 'rejected')]!
  await acceptInvite(winner, key(), fixture.token)
  await leaveGroup(winner, key(), fixture.groupId)
  await acceptInvite(loser, key(), fixture.token)
  await assert.rejects(acceptInvite(winner, key(), fixture.token), error => error instanceof AppError && error.code === 'group_member_limit_exceeded')
  const counts = await inspect(async client => (await client.query(`SELECT
    COUNT(*) FILTER (WHERE left_at IS NULL)::int AS total,
    COUNT(*) FILTER (WHERE left_at IS NULL AND user_id=ANY($2::text[]))::int AS accepted_candidates
    FROM group_members WHERE group_id=$1`, [fixture.groupId, candidates.map(person => person.userId)])).rows[0])
  assert.equal(counts.total, 10)
  assert.equal(counts.accepted_candidates, 1)
})

test('an upload already validated before a concurrent round lock is rejected after acquiring the write lock', async () => {
  const fixture = await recordingRound()
  const gate = createDatabaseClient(testUrl!)
  const requestKey = key()
  let upload: Promise<{ result?: unknown; error?: unknown }> | undefined
  let gateHeld = false
  try {
    await gate.connect()
    await gate.query('BEGIN')
    gateHeld = true
    await gate.query('SELECT pg_advisory_xact_lock(1684106607)')
    upload = addReceipt(fixture.participant, requestKey, fixture.roundId, fixture.expenseId, fixture.version, png, 'image/png')
      .then(result => ({ result }), error => ({ error }))

    // Observe the actual pending PostgreSQL lock, proving parsing completed before the state change.
    const deadline = Date.now() + 4000
    while (true) {
      await gate.query('SELECT pg_stat_clear_snapshot()')
      const waiting = await gate.query(`SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
        WHERE l.locktype='advisory' AND NOT l.granted AND a.application_name=$1`, [applicationName])
      if (waiting.rowCount) break
      assert.ok(Date.now() < deadline, 'upload did not reach its PostgreSQL write-lock wait')
      await sleep(20)
    }
    const now = currentTimestamp()
    // The competing transaction confirms and sends this valid 3 / 2 round while the upload waits.
    await gate.query('UPDATE expenses SET base_share_minor=1,remainder_units=1 WHERE round_id=$1', [fixture.roundId])
    await gate.query("UPDATE rounds SET status='CONFIRMED',confirmed_at=$2,version=version+1 WHERE id=$1 AND status='RECORDING'", [fixture.roundId, now])
    await gate.query("UPDATE rounds SET status='LOCKED',locked_at=$2,version=version+1 WHERE id=$1 AND status='CONFIRMED'", [fixture.roundId, now])
    await gate.query('COMMIT')
    gateHeld = false

    const outcome = await upload
    assert.ok(outcome.error instanceof AppError)
    assert.equal(outcome.error.code, 'invalid_round_state')
    const persisted = await gate.query(`SELECT
      (SELECT COUNT(*)::int FROM expense_receipts WHERE expense_id=$1) AS receipts,
      (SELECT COUNT(*)::int FROM mutation_requests WHERE request_key=$2) AS successful_requests`, [fixture.expenseId, requestKey])
    assert.deepEqual(persisted.rows[0], { receipts: 0, successful_requests: 0 })
    const current = await getRound(fixture.owner, fixture.roundId, new URLSearchParams())
    assert.equal(current.status, 'LOCKED')
    assert.equal(current.version, fixture.version + 2)
    assert.equal(current.expenses[0].amountMinor, '3')
    const drawn = await roundCommand(fixture.owner, key(), fixture.roundId, 'draw', { expectedVersion: current.version })
    await roundCommand(fixture.owner, key(), fixture.roundId, 'force-complete', { expectedVersion: drawn.version })
  } finally {
    if (gateHeld) await gate.query('ROLLBACK').catch(() => {})
    if (upload) await upload
    await gate.end()
  }
})
