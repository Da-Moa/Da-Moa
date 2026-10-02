import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { readAccessToken } from '../src/lib/auth.ts'
import { signInKakao } from '../src/lib/auth-store.ts'
import { createDatabaseClient } from '../src/lib/db.ts'
import { acceptInvite, createGroup, createInvite, getGroup, getInvite, leaveGroup, listGroups, revokeInvite } from '../src/Domain/Group/Backend/index.ts'
import { applyMigrations } from './migrations.mjs'
import { completeTestOnboarding } from './bank-test-support.ts'

const database = process.env.TEST_DATABASE_URL
if (!database || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(database).hostname) || !new URL(database).pathname.toLowerCase().includes('test')) throw new Error('TEST_DATABASE_URL must name an isolated local test database')
process.env.DATABASE_URL = database
process.env.AUTH_JWT_SECRET ||= 'isolated-group-test-secret-at-least-32-bytes'

test('Group public operations preserve transactions, query counts, replay privacy and rollback', async t => {
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
    const trace = async <T>(expected: number, write: boolean, work: () => Promise<T>) => {
      statements = []
      const result = await work()
      assert.equal(statements.length, expected, statements.join('\n'))
      assert.equal(statements[0], write ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      assert.equal(statements.at(-1), 'COMMIT')
      assert.equal(statements.some(sql => sql.includes('pg_advisory_xact_lock')), write)
      return result
    }
    try {
      const createKey = randomUUID(), body = { name: `모임 SQL ${randomUUID()}` }
      const group = await trace(10, true, () => createGroup(owner, createKey, body))
      assert.deepEqual(await trace(7, true, () => createGroup(owner, createKey, body)), group)
      const list = await trace(8, false, () => listGroups(owner, new URLSearchParams({ q: body.name })))
      assert.equal(list.items.length, 1)
      assert.equal(list.items[0].memberCount, 1)
      assert.equal((await trace(9, false, () => getGroup(owner, group.id))).members[0].userId, owner.userId)
      const inviteKey = randomUUID()
      const invite = await trace(10, true, () => createInvite(owner, inviteKey, group.id, {}))
      const replay = await trace(7, true, () => createInvite(owner, inviteKey, group.id, {}))
      assert.deepEqual(replay, { id: invite.id, inviteId: invite.id, linkUnavailable: true })
      assert.ok(!JSON.stringify(replay).includes(invite.sharePath!))
      const token = invite.sharePath!.split('/').at(-1)!
      assert.equal((await trace(7, false, () => getInvite(participant, token))).isMember, false)
      const acceptKey = randomUUID()
      await trace(12, true, () => acceptInvite(participant, acceptKey, token))
      await trace(7, true, () => acceptInvite(participant, acceptKey, token))
      await trace(11, true, () => acceptInvite(participant, randomUUID(), token))
      const detail = await trace(8, false, () => getGroup(participant, group.id))
      assert.deepEqual(detail.members.map(member => member.userId), [owner.userId, participant.userId])
      assert.deepEqual(detail.invites, [])
      const failedKey = randomUUID()
      statements = []
      await assert.rejects(createInvite(owner, failedKey, group.id, { replaceInviteId: randomUUID() }), (error: { code: string }) => error.code === 'not_found')
      assert.equal(statements.at(-1), 'ROLLBACK')
      assert.equal((await client.query('SELECT 1 FROM mutation_requests WHERE request_key=$1', [failedKey])).rows.length, 0)
      const replaced = await trace(11, true, () => createInvite(owner, randomUUID(), group.id, { replaceInviteId: invite.id }))
      await assert.rejects(getInvite(participant, token), (error: { code: string }) => error.code === 'not_found')
      await trace(10, true, () => revokeInvite(owner, randomUUID(), group.id, replaced.id))
      await trace(11, true, () => leaveGroup(participant, randomUUID(), group.id))
      await trace(12, true, () => leaveGroup(owner, randomUUID(), group.id))
      assert.equal((await trace(6, false, () => listGroups(owner, new URLSearchParams({ q: body.name })))).items.length, 0)
      assert.equal((await client.query('SELECT COUNT(*)::int AS count FROM group_members WHERE group_id=$1 AND left_at IS NULL', [group.id])).rows[0].count, 0)
    } finally {
      logger.mock.restore()
      if (previous === undefined) delete process.env.DB_QUERY_LOG
      else process.env.DB_QUERY_LOG = previous
    }
  } finally { await client.end() }
})
