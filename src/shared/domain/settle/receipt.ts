export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024
// Leave room for the multipart boundary, filename and expectedVersion.
export const MAX_RECEIPT_REQUEST_BYTES = MAX_RECEIPT_BYTES + 64 * 1024
export const RECEIPT_MAX_EDGE = 2048
