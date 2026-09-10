import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { before, test } from 'node:test'
import {
  createAccessToken, createRefreshToken, currentTimestamp, hashRefreshToken, readAccessToken, readRefreshToken,
  type AccessToken,
} from '../src/lib/auth.ts'
import {
  completeOnboarding, deleteRefreshSession, rotateRefreshSession, signInKakao, updateBankAccount, withdrawAccount,
  type AuthSession,
} from '../src/lib/auth-store.ts'
import { getAccount } from '../src/lib/authorization.ts'
import { createDatabaseClient, withReadTransaction, withWriteTransaction } from '../src/lib/db.ts'
import { AppError } from '../src/lib/errors.ts'
import { acceptInvite, createGroup, createInvite, getGroup, getInvite, listGroups } from '../src/lib/group-store.ts'
import { applyMigrations } from './migrations.mjs'

const testUrl = process.env.TEST_DATABASE_URL
if (!testUrl || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(testUrl).hostname) || !new URL(testUrl).pathname.toLowerCase().includes('test')) throw new Error('TEST_DATABASE_URL must name an isolated local test database; authentication tests never use DATABASE_URL implicitly')
process.env.DATABASE_URL = testUrl
process.env.AUTH_JWT_SECRET = 'isolated-auth-integration-test-secret-at-least-32-bytes'

const bank = { bankName: '테스트 은행', accountNumber: '00-123 456', accountHolder: '테스트 사용자' }
const profile = { displayName: '검증 사용자', email: null, profileImageUrl: null }
const accessOf = (session: AuthSession): AccessToken => {
  const access = readAccessToken(session.accessToken)
  assert.ok(access)
  return access
}
const codeIs = (code: string) => (error: unknown) => error instanceof AppError && error.code === code

async function newAccount() {
  const subject = `integration-${randomUUID()}`
  const onboarding = await signInKakao(subject, profile)
  assert.equal(onboarding.purpose, 'onboarding')
  const session = await completeOnboarding(accessOf(onboarding), bank)
  return { subject, onboarding, session, access: accessOf(session) }
}

async function assertCurrencyUpgrade(client: ReturnType<typeof createDatabaseClient>) {
  const schema = `currency_upgrade_${randomUUID().replaceAll('-', '')}`
  await client.query(`CREATE SCHEMA ${schema}`)
  try {
    await client.query(`SET search_path TO ${schema}`)
    await client.query('CREATE TABLE schema_migrations(version TEXT PRIMARY KEY, applied_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::BIGINT)')
    for (const version of ['001-auth-lifecycle.sql', '002-groups-settlement.sql', '003-round-cascade-constraints.sql']) {
      await client.query(await readFile(new URL(`./migrations/${version}`, import.meta.url), 'utf8'))
      await client.query('INSERT INTO schema_migrations(version,applied_at) VALUES($1,1)', [version])
    }
    const userId = randomUUID(), legacyMemberId = randomUUID(), sessionId = randomUUID(), now = currentTimestamp()
    await client.query(`INSERT INTO users(id,provider,provider_subject,created_at,updated_at,bank_name,account_number,account_holder,bank_updated_at,onboarding_completed_at)
      VALUES($1,'kakao',$1,$2,$2,'기존 은행','001234','기존 회원',$2,$2)`, [userId, now])
    await client.query(`INSERT INTO users(id,provider,provider_subject,created_at,updated_at,bank_name,account_number,account_holder,bank_updated_at,onboarding_completed_at)
      VALUES($1,'kakao',$1,$2,$2,'기존 은행','005678','기존 참여자',$2,$2)`, [legacyMemberId, now])
    await client.query(`INSERT INTO refresh_sessions(id,user_id,token_hash,issued_at,expires_at,purpose)
      VALUES($1,$2,$3,$4,$5,'app')`, [sessionId, userId, hashRefreshToken(sessionId), now, now + 1000])
    let missingCreatorRoundId = '', lateJoinedRoundId = ''
    for (const currency of ['KRW', 'USD', 'JPY']) {
      const groupId = randomUUID(), roundId = randomUUID()
      await client.query('INSERT INTO groups(id,creator_id,name,base_currency,created_at) VALUES($1,$2,$3,$3,$4)', [groupId, userId, currency, now])
      await client.query('INSERT INTO group_members(group_id,user_id,joined_at) VALUES($1,$2,$3)', [groupId, userId, now])
      await client.query("INSERT INTO rounds(id,group_id,name,currency,status,created_at) VALUES($1,$2,'기존 회차',$3,'RECORDING',$4)", [roundId, groupId, currency, now])
      await client.query("INSERT INTO round_members(round_id,user_id,display_name_snapshot,joined_at) VALUES($1,$2,'기존 회원',$3)", [roundId, userId, now])
      if (currency === 'KRW') {
        lateJoinedRoundId = roundId
        await client.query('INSERT INTO group_members(group_id,user_id,joined_at) VALUES($1,$2,$3)', [groupId, legacyMemberId, now])
        await client.query("INSERT INTO round_members(round_id,user_id,display_name_snapshot,joined_at) VALUES($1,$2,'기존 참여자',$3)", [roundId, legacyMemberId, now + 1])
        await client.query("UPDATE rounds SET status='COMPLETED',confirmed_at=$2,locked_at=$2,finalized_at=$2,completed_at=$2 WHERE id=$1", [roundId, now])
        await client.query('INSERT INTO settlement_transfers(round_id,sender_id,receiver_id,amount_minor) VALUES($1,$2,$3,1)', [roundId, legacyMemberId, userId])
      }
      if (currency === 'JPY') missingCreatorRoundId = roundId
    }
    await client.query('DELETE FROM round_members WHERE round_id=$1 AND user_id=$2', [missingCreatorRoundId, userId])
    const beforeRounds = (await client.query('SELECT * FROM rounds ORDER BY id')).rows
    const beforeSession = (await client.query('SELECT * FROM refresh_sessions WHERE id=$1', [sessionId])).rows
    for (const version of ['004-round-currency.sql', '005-round-creator.sql', '006-receipt-avif.sql', '007-settlement-check.sql']) {
      await client.query(await readFile(new URL(`./migrations/${version}`, import.meta.url), 'utf8'))
      await client.query('INSERT INTO schema_migrations(version,applied_at) VALUES($1,1)', [version])
    }
    const backfilledCreator = (await client.query(`SELECT rm.display_name_snapshot,rm.joined_at,r.created_at FROM round_members rm
      JOIN rounds r ON r.id=rm.round_id WHERE rm.round_id=$1 AND rm.user_id=$2`, [missingCreatorRoundId, userId])).rows[0]
    assert.equal(backfilledCreator.display_name_snapshot, '카카오 사용자')
    assert.equal(backfilledCreator.joined_at, backfilledCreator.created_at, '005 must restore a missing legacy creator membership at round creation')
    const correctedMembership = (await client.query(`SELECT rm.joined_at,r.completed_at FROM round_members rm
      JOIN rounds r ON r.id=rm.round_id WHERE rm.round_id=$1 AND rm.user_id=$2`, [lateJoinedRoundId, legacyMemberId])).rows[0]
    assert.equal(correctedMembership.joined_at, correctedMembership.completed_at, '007 must repair a legacy member timestamp later than completion')
    assert.equal((await client.query(`SELECT count(*)::int AS count FROM round_members rm JOIN rounds r ON r.id=rm.round_id
      WHERE r.status='COMPLETED' AND rm.settlement_checked_at=r.completed_at`)).rows[0].count, 2, '007 must persist its receiver-level state before 008 runs later')
    await applyMigrations(client)
    const upgradedRounds = (await client.query('SELECT * FROM rounds ORDER BY id')).rows
    assert.deepEqual(upgradedRounds.map(({ creator_id: _, ...round }) => round), beforeRounds, '004 and 005 must preserve every existing round and its currency')
    assert.ok(upgradedRounds.every(round => round.creator_id === userId), '005 must assign the prior group creator to existing rounds')
    assert.deepEqual((await client.query('SELECT * FROM refresh_sessions WHERE id=$1', [sessionId])).rows, beforeSession, '004 must not revoke or replace existing app sessions')
    assert.equal((await client.query("SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='groups' AND column_name='base_currency'", [schema])).rowCount, 0)
    assert.equal((await client.query("SELECT 1 FROM schema_migrations WHERE version='004-round-currency.sql'")).rowCount, 1)
    assert.equal((await client.query("SELECT 1 FROM schema_migrations WHERE version='005-round-creator.sql'")).rowCount, 1)
    assert.equal((await client.query("SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='round_members' AND column_name='settlement_checked_at'", [schema])).rowCount, 0)
    assert.equal((await client.query("SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='settlement_transfers' AND column_name='received_at'", [schema])).rowCount, 1)
    assert.equal((await client.query("SELECT 1 FROM schema_migrations WHERE version='007-settlement-check.sql'")).rowCount, 1)
    assert.equal((await client.query("SELECT 1 FROM schema_migrations WHERE version='008-transfer-receipt-check.sql'")).rowCount, 1)
    assert.equal((await client.query('SELECT count(*)::int AS count FROM settlement_transfers t JOIN rounds r ON r.id=t.round_id WHERE r.status=\'COMPLETED\' AND t.received_at=r.completed_at')).rows[0].count, 1)
  } finally {
    await client.query('SET search_path TO public')
    await client.query(`DROP SCHEMA ${schema} CASCADE`)
  }
}

before(async () => {
  const client = createDatabaseClient(process.env.TEST_DATABASE_URL!)
  try {
    await client.connect()
    await applyMigrations(client)
  } finally { await client.end() }
})

test('onboarding purpose, bank normalization, request replay, logout, and one-time session migration', async () => {
  const subject = `integration-${randomUUID()}`
  const limited = await signInKakao(subject, profile)
  const limitedAccess = accessOf(limited)
  assert.equal(limited.accessMaxAge, 600)
  assert.equal((await getAccount(limitedAccess, true)).onboardingCompletedAt, null)
  await assert.rejects(getAccount(limitedAccess), codeIs('onboarding_required'))
  await assert.rejects(createGroup(limitedAccess, randomUUID(), { name: '제한 세션 모임' }), codeIs('onboarding_required'))

  const app = await completeOnboarding(limitedAccess, bank)
  const access = accessOf(app)
  assert.equal(app.userId, limited.userId)
  assert.equal((await getAccount(access)).accountNumber, '00123456')
  await assert.rejects(getAccount(limitedAccess, true), codeIs('unauthorized'))
  await assert.rejects(completeOnboarding(limitedAccess, bank), codeIs('unauthorized'))

  const key = randomUUID()
  const nextBank = { ...bank, accountNumber: '000987' }
  const result = await updateBankAccount(access, key, nextBank)
  assert.deepEqual(await updateBankAccount(access, key, nextBank), result)
  await assert.rejects(updateBankAccount(access, key, { ...nextBank, accountNumber: '123' }), codeIs('idempotency_conflict'))
  assert.equal((await getAccount(access)).accountNumber, '000987')
  const mutation = await withReadTransaction(async client => client.query('SELECT response_metadata FROM mutation_requests WHERE actor_id=$1 AND request_key=$2', [app.userId, key]))
  assert.deepEqual(mutation.rows.map(row => row.response_metadata), [{ id: app.userId }])

  const client = createDatabaseClient(process.env.TEST_DATABASE_URL!)
  try {
    await client.connect()
    await applyMigrations(client)
    await assertCurrencyUpgrade(client)
  } finally { await client.end() }
  assert.equal((await getAccount(access)).id, app.userId, 'repeated migrations must not revoke newer sessions')
  await deleteRefreshSession(app.userId, access.sessionId)
  await assert.rejects(getAccount(access), codeIs('unauthorized'))
})

test('withdrawal checks all unfinished history including excluded members; rejoin preserves identity but never memberships', async () => {
  const owner = await newAccount()
  const participant = await newAccount()
  const third = await newAccount()
  const group = await createGroup(owner.access, randomUUID(), { name: '회원 상태 검증' })
  const invite = await createInvite(owner.access, randomUUID(), group.id, {})
  const token = invite.sharePath!.split('/').at(-1)!
  await acceptInvite(participant.access, randomUUID(), token)
  await acceptInvite(third.access, randomUUID(), token)
  const roundIds = [randomUUID(), randomUUID()]
  const now = currentTimestamp()
  await withWriteTransaction(async client => {
    for (const id of roundIds) {
      await client.query("INSERT INTO rounds(id,group_id,creator_id,name,currency,status,created_at) VALUES($1,$2,$3,'진행 회차','KRW','RECORDING',$4)", [id, group.id, owner.session.userId, now])
      for (const userId of [owner.session.userId, participant.session.userId, third.session.userId]) {
        await client.query('INSERT INTO round_members(round_id,user_id,display_name_snapshot,joined_at,excluded_at) VALUES($1,$2,$3,$4,$5)', [id, userId, profile.displayName, now, userId === participant.session.userId ? now : null])
      }
    }
  })
  await assert.rejects(withdrawAccount(participant.access), error => {
    assert.ok(error instanceof AppError)
    assert.equal(error.code, 'unfinished_rounds')
    assert.deepEqual(new Set((error.details as { rounds: { id: string }[] }).rounds.map(round => round.id)), new Set(roundIds))
    return true
  })
  assert.equal((await getAccount(participant.access)).deletedAt, null)
  await withWriteTransaction(async client => {
    await client.query('DELETE FROM rounds WHERE id=$1', [roundIds[0]])
  })
  await assert.rejects(withdrawAccount(participant.access), codeIs('unfinished_rounds'))
  // A completed historical round with no net payments is retained as an imported historical fixture.
  await withWriteTransaction(async client => {
    const id = roundIds[1]
    const expenseId = randomUUID()
    await client.query('UPDATE round_members SET excluded_at=NULL WHERE round_id=$1', [id])
    await client.query(`INSERT INTO expenses(id,round_id,author_id,payer_id,description,amount_minor,split_mode,base_share_minor,remainder_units,created_at,updated_at,updated_by)
      VALUES($1,$2,$3,$3,'본인 부담 기록',100,'SELECTED',100,0,$4,$4,$3)`, [expenseId, id, owner.session.userId, now])
    await client.query('INSERT INTO expense_shares(expense_id,round_id,user_id,final_amount_minor,received_remainder) VALUES($1,$2,$3,100,false)', [expenseId, id, owner.session.userId])
    for (const userId of [owner.session.userId, participant.session.userId, third.session.userId]) {
      const amount = userId === owner.session.userId ? '100' : '0'
      await client.query('INSERT INTO settlement_balances(round_id,user_id,paid_minor,burden_minor,balance_minor) VALUES($1,$2,$3,$3,0)', [id, userId, amount])
    }
    await client.query("UPDATE rounds SET status='COMPLETED',confirmed_at=$2,locked_at=$2,finalized_at=$2,completed_at=$2 WHERE id=$1", [id, now])
  })
  await withdrawAccount(participant.access)
  await assert.rejects(getAccount(participant.access), codeIs('unauthorized'))
  const withdrawn = await withReadTransaction(async client => client.query(`
    SELECT u.deleted_at, m.left_at, (SELECT COUNT(*) FROM round_members rm WHERE rm.user_id=u.id) AS history_count
    FROM users u JOIN group_members m ON m.user_id=u.id WHERE u.id=$1 AND m.group_id=$2
  `, [participant.session.userId, group.id]))
  assert.notEqual(withdrawn.rows[0].deleted_at, null)
  assert.notEqual(withdrawn.rows[0].left_at, null)
  assert.equal(withdrawn.rows[0].history_count, '1')

  const returning = await signInKakao(participant.subject, profile)
  assert.equal(returning.purpose, 'onboarding')
  assert.equal(returning.userId, participant.session.userId)
  await assert.rejects(getAccount(accessOf(returning)), codeIs('onboarding_required'))
  await assert.rejects(completeOnboarding(accessOf(returning), bank), codeIs('rejoin_confirmation_required'))
  const restored = await completeOnboarding(accessOf(returning), { ...bank, confirmRejoin: true })
  const restoredAccess = accessOf(restored)
  assert.equal(restored.userId, participant.session.userId)
  assert.equal((await listGroups(restoredAccess, new URLSearchParams())).items.length, 0)
  await assert.rejects(getGroup(restoredAccess, group.id), codeIs('not_found'))
  await assert.rejects(getAccount(participant.access), codeIs('unauthorized'))
  const retained = await withReadTransaction(client => client.query('SELECT round_id FROM round_members WHERE user_id=$1', [restored.userId]))
  assert.deepEqual(retained.rows.map(row => row.round_id), [roundIds[1]])
  assert.equal((await getInvite(restoredAccess, token)).isMember, false)
  await acceptInvite(restoredAccess, randomUUID(), token)
  assert.ok((await getGroup(restoredAccess, group.id)).members.some(member => member.userId === restored.userId))
  assert.equal((await getGroup(restoredAccess, group.id)).isCreator, false)

  await withdrawAccount(owner.access)
  const ownerReturning = await signInKakao(owner.subject, profile)
  const ownerRestored = await completeOnboarding(accessOf(ownerReturning), { ...bank, confirmRejoin: true })
  await assert.rejects(getGroup(accessOf(ownerRestored), group.id), codeIs('not_found'))
  await assert.rejects(getInvite(restoredAccess, token), codeIs('not_found'), 'an inactive creator membership makes old invitations unusable')
})

test('refresh rotation is single-use and cannot upgrade onboarding or resurrect revoked sessions', async () => {
  const user = await newAccount()
  const refresh = readRefreshToken(user.session.refreshToken)!
  const now = currentTimestamp()
  const replacements = [randomUUID(), randomUUID()].map(id => {
    const token = createRefreshToken(user.session.userId, id, undefined, now)
    return { id, token, input: {
      expiresAt: now + 1000, id, issuedAt: now, now, previousSessionId: refresh.sessionId,
      previousTokenHash: hashRefreshToken(user.session.refreshToken), tokenHash: hashRefreshToken(token), userId: user.session.userId,
    } }
  })
  const results = await Promise.all(replacements.map(item => rotateRefreshSession(item.input)))
  assert.equal(results.filter(Boolean).length, 1)
  await assert.rejects(getAccount(user.access), codeIs('unauthorized'))
  const winner = replacements[results.findIndex(Boolean)]
  const nextAccess = readAccessToken(createAccessToken(user.session.userId, winner.id, undefined, now))!
  assert.equal((await getAccount(nextAccess)).id, user.session.userId)
  await withdrawAccount(nextAccess)
  assert.equal(await rotateRefreshSession({ ...winner.input, id: randomUUID(), tokenHash: randomUUID(), previousSessionId: winner.id, previousTokenHash: hashRefreshToken(winner.token) }), false)

  const limited = await signInKakao(`integration-${randomUUID()}`, profile)
  assert.equal(await rotateRefreshSession({
    expiresAt: now + 1000, id: randomUUID(), issuedAt: now, now,
    previousSessionId: accessOf(limited).sessionId, previousTokenHash: hashRefreshToken(limited.refreshToken),
    tokenHash: randomUUID(), userId: limited.userId,
  }), false)
})

test('sign-in racing withdrawal cannot leave a valid app session for a deleted account', async () => {
  const user = await newAccount()
  const [login] = await Promise.all([signInKakao(user.subject, profile), withdrawAccount(user.access)])
  const state = await withReadTransaction(client => client.query(`
    SELECT u.deleted_at,
      (SELECT COUNT(*) FROM refresh_sessions s WHERE s.user_id=u.id AND s.purpose='app' AND s.revoked_at IS NULL AND s.expires_at>$2) AS app_sessions
    FROM users u WHERE u.id=$1
  `, [user.session.userId, currentTimestamp()]))
  assert.notEqual(state.rows[0].deleted_at, null)
  assert.equal(state.rows[0].app_sessions, '0')
  await assert.rejects(getAccount(accessOf(login)), error => error instanceof AppError && ['unauthorized', 'onboarding_required'].includes(error.code))
})
