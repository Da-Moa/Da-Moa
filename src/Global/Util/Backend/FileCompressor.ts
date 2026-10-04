import 'server-only'
import { createHash } from 'node:crypto'
import { AppError } from '../../../lib/errors'

export async function convertReceipt(content: Uint8Array, claimedType: string, name?: string) {
  const extension = name?.match(/\.([^.]+)$/)?.[1].toLowerCase()
  const extensionType = extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : null
  if (name !== undefined && (!extensionType || (claimedType && claimedType !== extensionType))) {
    throw new AppError(415, 'unsupported_receipt_type', 'JPEG, PNG, WebP 이미지 파일을 선택해 주세요')
  }
  const source = Buffer.from(content)
  let sharp: typeof import('sharp').default
  try { sharp = (await import('sharp')).default }
  catch (error) {
    console.error('receipt_converter_unavailable', error)
    throw new AppError(503, 'storage_unavailable', '영수증을 저장할 수 없어요. 같은 요청 키로 다시 시도해 주세요')
  }
  try {
    const image = sharp(source, { failOn: 'error' })
    const format = (await image.metadata()).format
    const mimeType = format === 'jpeg' ? 'image/jpeg' : format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : null
    if (!mimeType || ((claimedType && claimedType !== mimeType) || (extensionType && extensionType !== mimeType))) throw new AppError(415, 'unsupported_receipt_type', 'JPEG, PNG, WebP 이미지 파일을 선택해 주세요')
    const converted = await image.autoOrient().avif({ quality: 80, effort: 2 }).toBuffer()
    return { content: converted, mimeType: 'image/avif', sha256: createHash('sha256').update(converted).digest('hex') }
  } catch (error) {
    if (error instanceof AppError) throw error
    if (error instanceof Error && /input buffer|vipsjpeg|vipspng|(?:jpeg|png|webp)load|webp:/i.test(error.message)) {
      throw new AppError(415, 'unsupported_receipt_type', 'JPEG, PNG, WebP 이미지 파일을 선택해 주세요')
    }
    console.error('receipt_conversion_failed', error)
    throw new AppError(503, 'storage_unavailable', '영수증을 저장할 수 없어요. 같은 요청 키로 다시 시도해 주세요')
  }
}

