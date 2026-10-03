import 'server-only'
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { AppError } from '../../../lib/errors'

function config() {
  const endpoint = process.env.MINIO_ENDPOINT
  const bucket = process.env.MINIO_BUCKET
  const accessKeyId = process.env.MINIO_ACCESS_KEY
  const secretAccessKey = process.env.MINIO_SECRET_KEY
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) throw new Error('MinIO configuration is required')
  return { bucket, client: new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId, secretAccessKey }, maxAttempts: 2 }) }
}

export async function putReceipt(key: string, content: Uint8Array, mimeType: string) {
  const { bucket, client } = config()
  try { await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: content, ContentType: mimeType })) }
  catch (error) {
    console.error('receipt_upload_failed', error)
    throw new AppError(503, 'storage_unavailable', '영수증을 저장할 수 없어요. 같은 요청 키로 다시 시도해 주세요')
  } finally { client.destroy() }
}

export async function readReceipt(key: string): Promise<Uint8Array> {
  const { bucket, client } = config()
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    if (!response.Body) throw new Error('Empty receipt object')
    return await response.Body.transformToByteArray()
  } catch (error) {
    console.error('receipt_read_failed', error)
    throw new AppError(503, 'storage_unavailable', '영수증을 불러올 수 없어요. 잠시 후 다시 시도해 주세요')
  } finally { client.destroy() }
}

export async function deleteReceiptObject(key: string) {
  const { bucket, client } = config()
  try { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })) }
  finally { client.destroy() }
}
