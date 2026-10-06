import 'server-only'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { AppError } from '../../../../Global/Util/Backend'
import { MAX_RECEIPT_BYTES } from '../../Shared'

export async function validateReceipt(content: Uint8Array, claimedType: string, name?: string) {
  if (content.byteLength > MAX_RECEIPT_BYTES) throw new AppError(413, 'receipt_too_large', '영수증 파일은 10MB 이하로 올려 주세요')
  const unsupported = () => new AppError(415, 'unsupported_receipt_type', 'AVIF 이미지 파일을 선택해 주세요')
  if (!content.byteLength || (name !== undefined && !/\.avif$/i.test(name)) || (claimedType && claimedType !== 'image/avif')) throw unsupported()
  const source = Buffer.from(content.buffer, content.byteOffset, content.byteLength)
  try {
    // Parse the actual container/codec with the existing pixel safety limit. Never re-encode.
    const metadata = await sharp(source, { failOn: 'error' }).metadata()
    if (metadata.format !== 'heif' || metadata.compression !== 'av1' || !metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) throw unsupported()
  } catch { throw unsupported() }
  return { content: source, mimeType: 'image/avif', sha256: createHash('sha256').update(source).digest('hex') }
}
