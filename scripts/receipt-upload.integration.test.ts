import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import sharp from 'sharp'
import { readAccessToken } from '../src/lib/auth.ts'
import { createDatabaseClient } from '../src/lib/db.ts'
import { uuidV7 } from '../src/lib/uuid.ts'
import { signInKakao } from '../src/Global/Auth/Backend/index.ts'
import { acceptInvite, createGroup, createInvite } from '../src/Domain/Group/Backend/index.ts'
import { addReceipt, createRound, getReceipt, saveExpense } from '../src/Domain/Settle/Backend/index.ts'
import { completeTestOnboarding } from './bank-test-support.ts'
import { applyMigrations } from './migrations.mjs'

const testUrl = process.env.TEST_DATABASE_URL
if (!testUrl || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(testUrl).hostname) || !new URL(testUrl).pathname.toLowerCase().includes('test')) throw new Error('TEST_DATABASE_URL must name an isolated local test database')
process.env.DATABASE_URL = testUrl
process.env.AUTH_JWT_SECRET ||= 'integration-only-not-a-production-secret-0123456789'
const key = () => randomUUID()
const code = (expected: string) => (error: unknown) => (error as { code: string }).code === expected

async function member() {
  const limited = await signInKakao(`receipt-upload:${key()}`, { displayName: '영수증 검증', email: null, profileImageUrl: null })
  const full = await completeTestOnboarding(readAccessToken(limited.accessToken), { bankName: '검증은행', accountNumber: '12340312345678', accountHolder: '영수증 검증' })
  return readAccessToken(full.accessToken)!
}

test('receipt upload authenticates before reading, saves in two SQL calls and cleans only its own rejected objects', async t => {
  const db = createDatabaseClient(testUrl)
  await db.connect()
  const queryLog = process.env.DB_QUERY_LOG
  const originalSend = S3Client.prototype.send
  let events: string[] = [], objects: string[] = [], deleted: string[] = [], failPut = false
  try {
    await applyMigrations(db)
    const owner = await member(), author = await member(), other = await member()
    const group = await createGroup(owner, uuidV7(), { name: '영수증 검증 모임' })
    const invite = await createInvite(owner, key(), group.id, {})
    for (const actor of [author, other]) await acceptInvite(actor, key(), invite.sharePath!.split('/').at(-1)!)
    const round = await createRound(owner, uuidV7(), group.id, { name: '영수증 검증 회차', participantIds: [owner.userId, author.userId, other.userId] })
    const expense = await saveExpense(author, key(), round.id, { currency: 'KRW', description: '영수증 검증 지출', amount: '10', payerId: author.userId, splitMode: 'ALL', expectedVersion: round.version })
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } }).avif().toBuffer()
    let version = expense.version!
    process.env.DB_QUERY_LOG = 'true'
    t.mock.method(console, 'info', (message: string) => { events.push(/FROM users u WHERE/.test(message.replace(/\s+/g, ' ')) ? 'AUTH' : 'SQL') })
    t.mock.method(S3Client.prototype, 'send', async function (this: S3Client, command: PutObjectCommand | GetObjectCommand | DeleteObjectCommand) {
      if (command instanceof PutObjectCommand) {
        events.push('PUT')
        if (failPut) throw new Error('test upload failure')
        assert.equal(command.input.ContentType, 'image/avif')
        assert.equal((await sharp(command.input.Body as Buffer).metadata()).format, 'heif')
        assert.deepEqual(command.input.Body, bytes, 'save the client AVIF without re-encoding')
        objects.push(command.input.Key!)
      }
      if (command instanceof DeleteObjectCommand) { events.push('DELETE'); deleted.push(command.input.Key!) }
      return Reflect.apply(originalSend, this, [command])
    })
    const reset = () => { events = []; objects = []; deleted = [] }
    const upload = (expectedVersion = version, name = 'receipt.AVIF', type = 'image/avif') => async () => {
      events.push('READ')
      return { expectedVersion, bytes, type, name }
    }
    let audienceCount = 0
    reset()
    await assert.rejects(addReceipt(null, '', round.id, expense.id, upload()), code('unauthorized'))
    assert.deepEqual(events, [])
    await assert.rejects(addReceipt({ ...owner, userId: key() }, '', round.id, expense.id, upload()), code('unauthorized'))
    assert.deepEqual(events, ['AUTH'])
    for (const [name, type] of [['receipt.gif', 'image/avif'], ['receipt.jpg', 'image/avif'], ['receipt', ''], ['receipt.webp', ''], ['receipt.avif', 'image/png']]) {
      reset()
      await assert.rejects(addReceipt(author, key(), round.id, expense.id, upload(version, name, type)), code('unsupported_receipt_type'))
      assert.deepEqual(events, ['AUTH', 'READ'])
    }
    reset()
    failPut = true
    await assert.rejects(addReceipt(author, key(), round.id, expense.id, upload()), code('storage_unavailable'))
    assert.deepEqual(events, ['AUTH', 'READ', 'PUT'])
    failPut = false
    reset()
    const ticket = key(), expectedVersion = version
    const saved = await addReceipt(author, ticket, round.id, expense.id, upload(expectedVersion), () => { audienceCount++ })
    const savedKey = objects[0]
    assert.deepEqual(events, ['AUTH', 'READ', 'PUT', 'SQL'])
    assert.equal(audienceCount, 1)
    version = saved.version!
    reset()
    assert.deepEqual(await addReceipt(author, ticket, round.id, expense.id, upload(expectedVersion), () => { audienceCount++ }), saved)
    assert.deepEqual(events, ['AUTH', 'READ', 'PUT', 'SQL', 'DELETE'])
    assert.deepEqual(deleted, objects)
    assert.notEqual(objects[0], savedKey)
    assert.equal(audienceCount, 1)
    for (const [actor, uploadVersion, retryTicket, failure] of [
      [other, version, key(), 'forbidden'],
      [author, expectedVersion, key(), 'stale_round'],
      [author, version, ticket, 'idempotency_conflict'],
    ] as const) {
      reset()
      await assert.rejects(addReceipt(actor, retryTicket, round.id, expense.id, upload(uploadVersion)), code(failure))
      assert.deepEqual(events, ['AUTH', 'READ', 'PUT', 'SQL', 'DELETE'])
      assert.deepEqual(deleted, objects)
      assert.notEqual(deleted[0], savedKey)
    }
    const stored = await getReceipt(owner, saved.id)
    assert.equal(stored.mimeType, 'image/avif')
    const current = (await db.query('SELECT version FROM rounds WHERE id=$1', [round.id])).rows[0]
    assert.equal(current.version, version)
    await db.query(`CREATE FUNCTION reject_receipt_upload() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test receipt insert failure'; END $$;
      CREATE TRIGGER reject_receipt_upload BEFORE INSERT ON expense_receipts FOR EACH ROW EXECUTE FUNCTION reject_receipt_upload()`)
    try {
      reset()
      await assert.rejects(addReceipt(author, key(), round.id, expense.id, upload()), code('P0001'))
      assert.deepEqual(events, ['AUTH', 'READ', 'PUT', 'SQL', 'DELETE'])
      assert.deepEqual(deleted, objects)
      assert.equal((await db.query('SELECT version FROM rounds WHERE id=$1', [round.id])).rows[0].version, version)
      assert.equal((await db.query('SELECT count(*)::int AS count FROM expense_receipts WHERE expense_id=$1', [expense.id])).rows[0].count, 1)
    } finally { await db.query('DROP TRIGGER reject_receipt_upload ON expense_receipts; DROP FUNCTION reject_receipt_upload()') }
    await t.test('simultaneous retries keep one receipt and preserve its object', async () => {
      reset()
      const ticket = key(), requestVersion = version
      let published = 0
      const outcomes = await Promise.allSettled([1, 2].map(() => addReceipt(author, ticket, round.id, expense.id, requestVersion, bytes, 'image/avif', () => { published++ })))
      const successes = outcomes.filter(outcome => outcome.status === 'fulfilled')
      assert.ok(successes.length >= 1)
      const saved = (successes[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof addReceipt>>>).value
      for (const outcome of outcomes) {
        if (outcome.status === 'fulfilled') assert.deepEqual(outcome.value, saved)
        else assert.equal(outcome.reason.code, 'stale_round')
      }
      assert.equal(published, 1)
      assert.equal(objects.length, 2)
      assert.equal(deleted.length, 1)
      const rows = (await db.query('SELECT object_key FROM expense_receipts WHERE expense_id=$1 AND id=$2', [expense.id, saved.id])).rows
      assert.equal(rows.length, 1)
      assert.ok(objects.includes(rows[0].object_key))
      assert.ok(!deleted.includes(rows[0].object_key))
      assert.deepEqual(await addReceipt(author, ticket, round.id, expense.id, requestVersion, bytes, 'image/avif'), saved)
      version = saved.version!
    })
    await t.test('same key on different rounds rolls back the losing upload and version', async () => {
      const second = await createRound(owner, uuidV7(), group.id, { name: '영수증 키 경합', participantIds: [owner.userId, author.userId] })
      const secondExpense = await saveExpense(author, key(), second.id, { currency: 'KRW', description: '다른 회차 지출', amount: '10', payerId: author.userId, splitMode: 'ALL', expectedVersion: second.version })
      reset()
      const ticket = key()
      const candidates = [[round.id, expense.id, version], [second.id, secondExpense.id, secondExpense.version!]] as const
      const outcomes = await Promise.allSettled(candidates.map(([roundId, expenseId, expectedVersion]) => addReceipt(author, ticket, roundId, expenseId, expectedVersion, bytes, 'image/avif')))
      assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1)
      assert.equal(objects.length, 2)
      assert.equal(deleted.length, 1)
      for (const [index, outcome] of outcomes.entries()) {
        if (outcome.status === 'rejected') {
          assert.equal(outcome.reason.code, 'idempotency_conflict')
          assert.equal((await db.query('SELECT version FROM rounds WHERE id=$1', [candidates[index][0]])).rows[0].version, candidates[index][2])
        } else {
          const objectKey = (await db.query('SELECT object_key FROM expense_receipts WHERE id=$1', [outcome.value.id])).rows[0].object_key
          assert.ok(!deleted.includes(objectKey))
        }
      }
    })
  } finally {
    if (queryLog === undefined) delete process.env.DB_QUERY_LOG
    else process.env.DB_QUERY_LOG = queryLog
    t.mock.restoreAll()
    await db.end()
  }
})
