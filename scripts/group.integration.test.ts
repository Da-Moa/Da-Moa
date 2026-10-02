import { uuidV7 } from '../src/lib/uuid.ts'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { readAccessToken } from '../src/lib/auth.ts'
import { signInKakao } from '../src/lib/auth-store.ts'
import { createDatabaseClient } from '../src/lib/db.ts'
import { acceptInvite, createGroup, createInvite, getGroup, getGroupMembers, getInvite, leaveGroup, listGroups, revokeInvite } from '../src/Domain/Group/Backend/index.ts'
import { applyMigrations } from './migrations.mjs'
import { completeTestOnboarding } from './bank-test-support.ts'

const database = process.env.TEST_DATABASE_URL
if (!database || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(database).hostname) || !new URL(database).pathname.toLowerCase().includes('test')) throw new Error('TEST_DATABASE_URL must name an isolated local test database')
process.env.DATABASE_URL = database
process.env.AUTH_JWT_SECRET ||= 'isolated-group-test-secret-at-least-32-bytes'

test('Group creation, lists and details use autocommit SQL; other operations preserve transactions, replay and rollback', async t => {
  const client = createDatabaseClient(database)
  await client.connect()
  try {
    await applyMigrations(client)
    const member = async (name: string) => {
      const onboarding = await signInKakao(`group-test:${randomUUID()}`, { displayName: name, email: null, profileImageUrl: null })
      return readAccessToken((await completeTestOnboarding(readAccessToken(onboarding.accessToken), { bankName: '테스트 은행', accountNumber: '12340312345678', accountHolder: name })).accessToken)!
    }
    const owner = await member('모임 생성자'), participant = await member('모임 참여자')
    const previous = process.env.DB_QUERY_LOG
    process.env.DB_QUERY_LOG = 'true'
    let statements: string[] = []
    const logger = t.mock.method(console, 'info', (message: string) => { statements.push(message.replace(/^SQL:\s*/, '').replace(/\s+/g, ' ').trim()) })
    const trace = async <T>(expected: number, write: boolean | null, work: () => Promise<T>) => {
      statements = []
      const result = await work()
      assert.equal(statements.length, expected, statements.join('\n'))
      if (write === null) {
        assert.ok(statements.every(sql => !/^(BEGIN|COMMIT|ROLLBACK|SET)\b/.test(sql) && !sql.includes('pg_advisory_xact_lock')))
      } else {
        assert.equal(statements[0], write ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        assert.equal(statements.at(-1), 'COMMIT')
        assert.equal(statements.some(sql => sql.includes('pg_advisory_xact_lock')), write)
      }
      return result
    }
    try {
      const createKey = uuidV7(), body = { name: `모임 SQL ${randomUUID()}` }
      const group = await trace(2, null, () => createGroup(owner, createKey, body))
      assert.equal(group.id, createKey)
      for (const name of [body.name, '다른 이름']) {
        statements = []
        await assert.rejects(createGroup(owner, createKey, { name }), (error: { code: string }) => error.code === 'group_already_exists')
        assert.equal(statements.length, 2)
        assert.ok(statements.every(sql => !/^(BEGIN|COMMIT|ROLLBACK|SET)\b/.test(sql) && !sql.includes('mutation_requests') && !sql.includes('pg_advisory_xact_lock')))
      }
      assert.equal((await client.query('SELECT 1 FROM mutation_requests WHERE request_key=$1', [createKey])).rowCount, 0)
      const concurrentKey = uuidV7()
      const concurrent = await Promise.allSettled(Array.from({ length: 5 }, () => createGroup(owner, concurrentKey, body)))
      assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1)
      assert.ok(concurrent.filter(result => result.status === 'rejected').every(result => result.reason.code === 'group_already_exists'))
      assert.equal((await client.query('SELECT COUNT(*)::int AS count FROM group_members WHERE group_id=$1', [concurrentKey])).rows[0].count, 1)
      await leaveGroup(owner, randomUUID(), concurrentKey)
      const rejectedKey = uuidV7(), constraint = `group_create_test_${randomUUID().replaceAll('-', '')}`
      await client.query(`ALTER TABLE group_members ADD CONSTRAINT ${constraint} CHECK (group_id <> '${rejectedKey}') NOT VALID`)
      try {
        await assert.rejects(createGroup(owner, rejectedKey, body), (error: { code: string; constraint: string }) => error.code === '23514' && error.constraint === constraint)
        assert.equal((await client.query('SELECT 1 FROM groups WHERE id=$1', [rejectedKey])).rowCount, 0, 'membership failure rolls back the group INSERT in the same statement')
      } finally { await client.query(`ALTER TABLE group_members DROP CONSTRAINT ${constraint}`) }
      const list = await trace(3, null, () => listGroups(owner, new URLSearchParams({ q: body.name })))
      assert.equal(list.items.length, 1)
      assert.equal(list.items[0].memberCount, 1)
      const ownerDetail = await trace(3, null, () => getGroup(owner, group.id))
      assert.deepEqual(ownerDetail, { id: group.id, name: body.name, creatorId: owner.userId, createdAt: ownerDetail.createdAt, isCreator: true, invites: [] })
      assert.match(statements[1], /JOIN group_members/)
      assert.equal((await trace(8, false, () => getGroupMembers(owner, group.id)))[0].userId, owner.userId)
      statements = []
      await assert.rejects(getGroup(participant, group.id), (error: { code: string }) => error.code === 'not_found')
      assert.equal(statements.length, 2)
      await assert.rejects(getGroupMembers(participant, group.id), (error: { code: string }) => error.code === 'not_found')
      const inviteKey = randomUUID()
      const invite = await trace(10, true, () => createInvite(owner, inviteKey, group.id, {}))
      assert.deepEqual((await trace(3, null, () => getGroup(owner, group.id))).invites.map(item => item.id), [invite.id])
      const replay = await trace(7, true, () => createInvite(owner, inviteKey, group.id, {}))
      assert.deepEqual(replay, { id: invite.id, inviteId: invite.id, linkUnavailable: true })
      assert.ok(!JSON.stringify(replay).includes(invite.sharePath!))
      const token = invite.sharePath!.split('/').at(-1)!
      assert.equal((await trace(7, false, () => getInvite(participant, token))).isMember, false)
      const acceptKey = randomUUID()
      await trace(12, true, () => acceptInvite(participant, acceptKey, token))
      await trace(7, true, () => acceptInvite(participant, acceptKey, token))
      await trace(11, true, () => acceptInvite(participant, randomUUID(), token))
      const second = await createGroup(owner, uuidV7(), { name: `${body.name} %_\\` })
      const secondInvite = await createInvite(owner, randomUUID(), second.id, {})
      await acceptInvite(participant, randomUUID(), secondInvite.sharePath!.split('/').at(-1)!)
      const orderedIds = [group.id, second.id].sort().reverse()
      // Reverse creation times so this fails if pagination still orders by created_at.
      for (const [index, id] of orderedIds.entries()) await client.query('UPDATE groups SET created_at=$2 WHERE id=$1', [id, index + 1])
      const combined = await trace(3, null, () => listGroups(owner, new URLSearchParams()))
      assert.deepEqual(combined.items.map(item => item.id), orderedIds)
      assert.ok(combined.items.every(item => item.memberCount === 2 && item.memberPreview[0].userId === owner.userId))
      assert.equal(statements.filter(sql => sql.includes('FROM users')).length, 2, 'one AUTH and one batch profile query, despite members shared across groups')
      assert.equal(JSON.stringify(combined).includes('member_ids'), false)
      const firstPage = await trace(3, null, () => listGroups(owner, new URLSearchParams({ q: body.name, limit: '1' })))
      assert.equal(firstPage.items[0].id, orderedIds[0])
      assert.ok(firstPage.nextCursor)
      const nextPage = await trace(3, null, () => listGroups(owner, new URLSearchParams({ q: body.name, limit: '1', cursor: firstPage.nextCursor! })))
      assert.deepEqual(nextPage.items.map(item => item.id), [orderedIds[1]])
      assert.equal(nextPage.nextCursor, null)
      for (const q of ['%_', '\\']) {
        assert.deepEqual((await trace(3, null, () => listGroups(owner, new URLSearchParams({ q })))).items.map(item => item.id), [second.id], 'LIKE metacharacters match literally')
      }
      await leaveGroup(owner, randomUUID(), second.id)
      const detail = await trace(2, null, () => getGroup(participant, group.id))
      assert.equal(detail.isCreator, false)
      assert.equal('members' in detail, false)
      assert.ok(statements.every(sql => !sql.includes('group_invites')))
      assert.deepEqual(detail.invites, [])
      assert.deepEqual((await trace(8, false, () => getGroupMembers(participant, group.id))).map(member => member.userId), [owner.userId, participant.userId])
      const failedKey = randomUUID()
      statements = []
      await assert.rejects(createInvite(owner, failedKey, group.id, { replaceInviteId: randomUUID() }), (error: { code: string }) => error.code === 'not_found')
      assert.equal(statements.at(-1), 'ROLLBACK')
      assert.equal((await client.query('SELECT 1 FROM mutation_requests WHERE request_key=$1', [failedKey])).rows.length, 0)
      const replaced = await trace(11, true, () => createInvite(owner, randomUUID(), group.id, { replaceInviteId: invite.id }))
      await assert.rejects(getInvite(participant, token), (error: { code: string }) => error.code === 'not_found')
      await trace(10, true, () => revokeInvite(owner, randomUUID(), group.id, replaced.id))
      assert.deepEqual((await trace(3, null, () => getGroup(owner, group.id))).invites, [])
      await trace(11, true, () => leaveGroup(participant, randomUUID(), group.id))
      statements = []
      await assert.rejects(getGroup(participant, group.id), (error: { code: string }) => error.code === 'not_found')
      assert.equal(statements.length, 2)
      await assert.rejects(getGroupMembers(participant, group.id), (error: { code: string }) => error.code === 'not_found')
      await trace(12, true, () => leaveGroup(owner, randomUUID(), group.id))
      assert.equal((await trace(2, null, () => listGroups(owner, new URLSearchParams({ q: body.name })))).items.length, 0)
      assert.equal((await client.query('SELECT COUNT(*)::int AS count FROM group_members WHERE group_id=$1 AND left_at IS NULL', [group.id])).rows[0].count, 0)
    } finally {
      logger.mock.restore()
      if (previous === undefined) delete process.env.DB_QUERY_LOG
      else process.env.DB_QUERY_LOG = previous
    }
  } finally { await client.end() }
})
