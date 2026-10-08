import { before } from 'node:test'
import { getPrismaClient } from '../../global/database/prisma.service.ts'
import { addStoredReceipt as addReceipt } from './receiptWorkerTestSupport'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import sharp from 'sharp'
import { readAccessToken } from '../../global/auth/native.ts'
import { createDatabaseClient } from '../../global/database/db.ts'
import { getDatabasePool } from '../../global/database/dbClient.mjs'
import { uuidV7 } from '../../../shared/uuid.ts'
import { signInKakao } from '../domainTestSupport';
import { acceptInvite, createGroup, createInvite } from '../domainTestSupport';
import { createRound, getReceipt, saveExpense } from '../domainTestSupport';
import { completeTestOnboarding } from './bankTestSupport.ts'
import { applyMigrations } from '../../../../scripts/migrations.mjs'

const testUrl = process.env.TEST_DATABASE_URL
if (!testUrl || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(testUrl).hostname) || !new URL(testUrl).pathname.toLowerCase().includes('test')) throw new Error('TEST_DATABASE_URL must name an isolated local test database')
process.env.DATABASE_URL = testUrl
process.env.AUTH_JWT_SECRET ||= 'integration-only-not-a-production-secret-0123456789'
const key = () => randomUUID()
const code = (expected: string) => (error: unknown) => (error as { code: string }).code === expected

test('receipt read checks account and round participation in two SQL calls before MinIO GET', async t => {
  const db = createDatabaseClient(testUrl)
  await db.connect()
  const queryLog = process.env.DB_QUERY_LOG
  const originalSend = S3Client.prototype.send
  try {
    await applyMigrations(db)
    const member = async () => {
      const signup = await signInKakao(`receipt-read:${key()}`, { displayName: '영수증 조회 검증', email: null, profileImageUrl: null })
      return readAccessToken((await completeTestOnboarding(readAccessToken(signup.accessToken), { bankName: '검증은행', accountHolder: '영수증 조회 검증', accountNumber: '12340312345678' })).accessToken)!
    }
    const owner = await member(), participant = await member(), groupOnly = await member(), outsider = await member()
    const group = await createGroup(owner, uuidV7(), { name: '영수증 조회 검증' })
    const invite = await createInvite(owner, key(), group.id, {})
    for (const actor of [participant, groupOnly]) await acceptInvite(actor, key(), invite.sharePath!.split('/').at(-1)!)
    const round = await createRound(owner, uuidV7(), group.id, { name: '영수증 조회 회차', participantIds: [owner.userId, participant.userId] })
    const expense = await saveExpense(owner, key(), round.id, { currency: 'KRW', description: '조회 검증 지출', amount: '10', payerId: owner.userId, splitMode: 'ALL', expectedVersion: round.version })
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } }).avif().toBuffer()
    const saved = await addReceipt(owner, key(), round.id, expense.id, expense.version!, bytes, 'image/avif')
    const objectKey = (await db.query('SELECT object_key FROM expense_receipts WHERE id=$1', [saved.id])).rows[0].object_key
    let events: string[] = [], statements: string[] = []
    process.env.DB_QUERY_LOG = 'true'
    t.mock.method(console, 'info', (message: string) => {
      const sql = message.replace(/^SQL:\s*/, '').replace(/\s+/g, ' ').trim()
      statements.push(sql)
      events.push(/FROM "public"\."users" WHERE/.test(sql) ? 'AUTH' : 'SQL')
    })
    t.mock.method(S3Client.prototype, 'send', async function (this: S3Client, command: GetObjectCommand) {
      assert.ok(command instanceof GetObjectCommand)
      assert.equal(command.input.Key, objectKey)
      const pool = getDatabasePool(testUrl)
      assert.equal(pool.idleCount, pool.totalCount, 'release the DB connection before waiting for MinIO')
      events.push('GET')
      return Reflect.apply(originalSend, this, [command])
    })
    const trace = async <T>(expected: string[], work: () => Promise<T>) => {
      events = []; statements = []
      const result = await work()
      assert.deepEqual(events, expected)
      assert.ok(statements.every(sql => !/^(BEGIN|COMMIT|ROLLBACK|SET)\b|pg_advisory|FOR UPDATE|FOR SHARE/.test(sql)))
      if (statements.length > 1) assert.match(statements[1], /FROM expense_receipts rc JOIN expenses e.*JOIN rounds r.*JOIN round_members viewer.*viewer.user_id = \$2.*rc.id = \$1/)
      return result
    }
    for (const actor of [owner, participant]) {
      const image = await trace(['AUTH', 'SQL', 'GET'], () => getReceipt(actor, saved.id))
      assert.equal(image.mimeType, 'image/avif')
      assert.equal((await sharp(image.content).metadata()).compression, 'av1')
    }
    for (const [actor, id, expected, events] of [
      [null, saved.id, 'unauthorized', []],
      [{ ...owner, userId: key() }, saved.id, 'unauthorized', ['AUTH']],
      [groupOnly, saved.id, 'not_found', ['AUTH', 'SQL']],
      [outsider, saved.id, 'not_found', ['AUTH', 'SQL']],
      [owner, key(), 'not_found', ['AUTH', 'SQL']],
    ] as const) await trace([...events], () => assert.rejects(getReceipt(actor, id), code(expected)))
    process.env.DB_QUERY_LOG = 'false'
    // Historical round participation remains readable after exclusion and leaving the group.
    await db.query('UPDATE round_members SET excluded_at=1 WHERE round_id=$1 AND user_id=$2', [round.id, participant.userId])
    await db.query('UPDATE group_members SET left_at=1 WHERE group_id=$1 AND user_id=$2', [group.id, participant.userId])
    process.env.DB_QUERY_LOG = 'true'
    await trace(['AUTH', 'SQL', 'GET'], () => getReceipt(participant, saved.id))
  } finally {
    if (queryLog === undefined) delete process.env.DB_QUERY_LOG
    else process.env.DB_QUERY_LOG = queryLog
    t.mock.restoreAll()
    await db.end()
  }
})

before(async () => { await getPrismaClient(process.env.TEST_DATABASE_URL!) })
