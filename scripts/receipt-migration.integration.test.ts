import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import sharp from 'sharp'
import { readAccessToken } from '../src/lib/auth.ts'
import { signInKakao } from '../src/lib/auth-store.ts'
import { createDatabaseClient } from '../src/lib/db.ts'
import { acceptInvite, createGroup, createInvite } from '../src/Domain/Group/Backend/index.ts'
import { addReceipt, createRound, deleteExpense, getReceipt, getRound, removeReceipt, roundCommand, saveExpense } from '../src/lib/round-store.ts'
import { completeTestOnboarding } from './bank-test-support.ts'
import { applyMigrations } from './migrations.mjs'

const testUrl = process.env.TEST_DATABASE_URL
if (!testUrl || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(testUrl).hostname) || !new URL(testUrl).pathname.toLowerCase().includes('test')) throw new Error('TEST_DATABASE_URL must name an isolated local test database')
process.env.AUTH_JWT_SECRET ||= 'integration-only-not-a-production-secret-0123456789'
const key = () => randomUUID()

test('legacy receipt migration preserves images and restores expense deletion and object uploads', async () => {
  const client = createDatabaseClient(testUrl)
  const schema = `receipt_upgrade_${key().replaceAll('-', '')}`
  const previousUrl = process.env.DATABASE_URL
  const scopedUrl = new URL(testUrl)
  scopedUrl.searchParams.set('options', `-csearch_path=${schema}`)
  await client.connect()
  try {
    await client.query(`CREATE SCHEMA ${schema}`)
    await client.query(`SET search_path TO ${schema}`)
    process.env.DATABASE_URL = scopedUrl.toString()
    await applyMigrations(client)
    // Reproduce the already-applied migration's historical inline-storage schema.
    await client.query(`ALTER TABLE expense_receipts DROP COLUMN object_key;
      ALTER TABLE expense_receipts ADD COLUMN content BYTEA NOT NULL;
      ALTER TABLE expense_receipts ADD CHECK (byte_size = octet_length(content));
      DELETE FROM schema_migrations WHERE version='014-legacy-receipt-storage.sql'`)

    const members = []
    for (const name of ['A', 'B', '외부인']) {
      const signup = await signInKakao(`receipt-migration:${key()}`, { displayName: name, email: null, profileImageUrl: null })
      const session = await completeTestOnboarding(readAccessToken(signup.accessToken), { bankName: '검증은행', accountHolder: name, accountNumber: '12340312345678' })
      members.push(readAccessToken(session.accessToken)!)
    }
    const [a, b, outsider] = members
    const group = await createGroup(a, key(), { name: '영수증 호환 검증' })
    const invite = await createInvite(a, key(), group.id, {})
    await acceptInvite(b, key(), invite.sharePath!.split('/').at(-1)!)
    const round = await createRound(a, key(), group.id, { name: '구버전 영수증', currency: 'KRW', participantIds: [a.userId, b.userId] })
    const version = async () => ({ expectedVersion: (await getRound(a, round.id, new URLSearchParams())).version })
    const expense = async () => saveExpense(a, key(), round.id, { description: '검증 지출', amount: '1000', payerId: a.userId, splitMode: 'ALL', ...await version() })
    const empty = await expense()
    const original = await expense()
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } }).png().toBuffer()
    const seed = async (expenseId: string) => {
      const id = key()
      await client.query('INSERT INTO expense_receipts(id,expense_id,uploaded_by,mime_type,byte_size,sha256,content,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [id, expenseId, a.userId, 'image/png', bytes.length, createHash('sha256').update(bytes).digest('hex'), bytes, Math.floor(Date.now() / 1000)])
      return id
    }
    const receiptId = await seed(original.id!)
    const deleteKey = key(), deleteBody = await version()
    await assert.rejects(deleteExpense(a, deleteKey, round.id, empty.id!, deleteBody), (error: unknown) => (error as { code: string }).code === '42703')
    await applyMigrations(client)
    await applyMigrations(client)
    assert.deepEqual((await client.query('SELECT content,object_key FROM expense_receipts WHERE id=$1', [receiptId])).rows[0], { content: bytes, object_key: null })
    const legacy = await getReceipt(a, receiptId)
    assert.equal(legacy.mimeType, 'image/png')
    assert.deepEqual(Buffer.from(legacy.content), bytes)
    await assert.rejects(getReceipt(outsider, receiptId), (error: unknown) => (error as { code: string }).code === 'not_found')
    await deleteExpense(a, deleteKey, round.id, empty.id!, deleteBody)

    await removeReceipt(a, key(), round.id, original.id!, receiptId, await version())
    const cascadeId = await seed(original.id!)
    await deleteExpense(a, key(), round.id, original.id!, await version())
    assert.equal((await client.query('SELECT id FROM expense_receipts WHERE id=$1', [cascadeId])).rowCount, 0)

    const uploadedExpense = await expense()
    const uploaded = await addReceipt(a, key(), round.id, uploadedExpense.id!, (await version()).expectedVersion, bytes, 'image/png')
    const stored = (await client.query('SELECT content,object_key FROM expense_receipts WHERE id=$1', [uploaded.id])).rows[0]
    assert.equal(stored.content, null)
    assert.ok(stored.object_key)
    const image = await getReceipt(a, uploaded.id!)
    assert.equal(image.mimeType, 'image/avif')
    assert.equal((await sharp(image.content).metadata()).compression, 'av1')
    await seed(uploadedExpense.id!)
    await roundCommand(a, key(), round.id, 'cancel', await version())
    assert.equal((await client.query('SELECT id FROM expense_receipts')).rowCount, 0)
  } finally {
    if (previousUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previousUrl
    await client.query('SET search_path TO public')
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await client.end()
  }
})
