import assert from 'node:assert/strict'
import test from 'node:test'
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { deleteReceiptObject, putReceipt, readReceipt } from '../../global/util/minio.util'

test('receipt objects use the configured private S3 bucket', async () => {
  const sent: string[] = []
  const originalSend = S3Client.prototype.send
  S3Client.prototype.send = (async function (command: PutObjectCommand | GetObjectCommand | DeleteObjectCommand) {
    assert.equal(command.input.Bucket, 'receipts-test')
    assert.equal(command.input.Key, 'receipts/example.avif')
    sent.push(command.constructor.name)
    if (command instanceof PutObjectCommand) {
      assert.equal(command.input.ContentType, 'image/avif')
      assert.deepEqual(command.input.Body, Uint8Array.from([1, 2, 3, 4]))
      return {}
    }
    if (command instanceof GetObjectCommand) return { Body: { transformToByteArray: async () => Uint8Array.from([1, 2, 3, 4]) } }
    return {}
  }) as typeof S3Client.prototype.send
  Object.assign(process.env, { MINIO_ENDPOINT: 'http://127.0.0.1:9000', MINIO_BUCKET: 'receipts-test', MINIO_ACCESS_KEY: 'test-access', MINIO_SECRET_KEY: 'test-secret' })
  try {
    assert.equal(await putReceipt('receipts/example.avif', Uint8Array.from([1, 2, 3, 4]), 'image/avif'), 'receipts/example.avif')
    assert.deepEqual(await readReceipt('receipts/example.avif'), Uint8Array.from([1, 2, 3, 4]))
    await deleteReceiptObject('receipts/example.avif')
    assert.deepEqual(sent, ['PutObjectCommand', 'GetObjectCommand', 'DeleteObjectCommand'])
  } finally {
    S3Client.prototype.send = originalSend
    for (const name of ['MINIO_ENDPOINT', 'MINIO_BUCKET', 'MINIO_ACCESS_KEY', 'MINIO_SECRET_KEY']) delete process.env[name]
  }
})
