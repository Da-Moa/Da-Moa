import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import sharp from 'sharp'
import { validateReceipt } from '../../domain/settle/service/receiptFile.ts'
import { MAX_RECEIPT_BYTES } from '../../../shared/domain/settle/receipt.ts'

test('receipt upload accepts AVIF/AV1 up to 10 MiB and preserves bytes without encoding', async t => {
  const png = await sharp({ create: { width: 2, height: 3, channels: 3, background: '#369' } }).png().toBuffer()
  const avif = await sharp(png).avif().toBuffer()
  t.mock.method(sharp.prototype, 'avif', () => { throw new Error('The backend must never encode receipts') })
  t.mock.method(sharp.prototype, 'toBuffer', () => { throw new Error('The backend must not decode/re-encode receipt pixels') })
  const accepted = await validateReceipt(avif, 'image/avif', 'receipt.AVIF')
  assert.deepEqual(accepted.content, avif)
  assert.equal(accepted.mimeType, 'image/avif')
  assert.equal(accepted.sha256, createHash('sha256').update(avif).digest('hex'))
  const padded = Buffer.alloc(MAX_RECEIPT_BYTES)
  avif.copy(padded)
  padded.writeUInt32BE(padded.length - avif.length, avif.length)
  padded.write('free', avif.length + 4, 'ascii')
  assert.equal((await validateReceipt(padded, '', 'receipt.avif')).content.byteLength, MAX_RECEIPT_BYTES)
  for (const [bytes, type, name] of [
    [png, 'image/avif', 'fake.avif'], [avif, 'image/png', 'receipt.avif'], [avif, 'image/avif', 'receipt.png'],
    [Buffer.from('<svg/>'), 'image/avif', 'fake.avif'], [Buffer.alloc(0), 'image/avif', 'empty.avif'],
    [avif.subarray(0, 32), 'image/avif', 'truncated.avif'],
  ] as const) await assert.rejects(validateReceipt(bytes, type, name), (error: unknown) => (error as { code: string }).code === 'unsupported_receipt_type')
  await assert.rejects(validateReceipt(Buffer.alloc(MAX_RECEIPT_BYTES + 1), 'image/avif', 'large.avif'), (error: unknown) => (error as { status: number; code: string }).status === 413 && (error as { code: string }).code === 'receipt_too_large')
})
