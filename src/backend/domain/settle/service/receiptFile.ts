import { settleErrors } from '../code/settle.error.code';
import { SettleException } from '../exception/settle.exception';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { AppError } from '../../../global/util';
import { MAX_RECEIPT_BYTES } from '../../../../shared/domain/settle';

export async function validateReceipt(
  content: Uint8Array,
  claimedType: string,
  name?: string,
) {
  if (content.byteLength > MAX_RECEIPT_BYTES)
    throw new SettleException(settleErrors.RECEIPT_TOO_LARGE);
  const unsupported = () =>
    new SettleException(settleErrors.UNSUPPORTED_RECEIPT_TYPE);
  if (
    !content.byteLength ||
    (name !== undefined && !/\.avif$/i.test(name)) ||
    (claimedType && claimedType !== 'image/avif')
  )
    throw unsupported();
  const source = Buffer.from(
    content.buffer,
    content.byteOffset,
    content.byteLength,
  );
  try {
    // Parse the actual container/codec with the existing pixel safety limit. Never re-encode.
    const metadata = await sharp(source, { failOn: 'error' }).metadata();
    if (
      metadata.format !== 'heif' ||
      metadata.compression !== 'av1' ||
      !metadata.width ||
      !metadata.height ||
      (metadata.pages ?? 1) !== 1
    )
      throw unsupported();
  } catch {
    throw unsupported();
  }
  return {
    content: source,
    mimeType: 'image/avif',
    sha256: createHash('sha256').update(source).digest('hex'),
  };
}
