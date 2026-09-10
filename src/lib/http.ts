import { AppError } from './errors'
import { objectBody } from './mutations'

export async function readBytes(request: Request, limit: number, code = 'request_too_large') {
  const tooLarge = () => new AppError(413, code, '요청 크기가 너무 커요')
  if (Number(request.headers.get('content-length')) > limit) throw tooLarge()
  const reader = request.body?.getReader()
  if (!reader) return new Uint8Array()
  const parts: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) { await reader.cancel(); throw tooLarge() }
      parts.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength }
  return bytes
}

export async function readJsonBody(request: Request, limit = 1024 * 1024) {
  const bytes = await readBytes(request, limit)
  if (!bytes.length) return {}
  let parsed: unknown
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { throw new AppError(400, 'invalid_input', '올바른 JSON 입력이 필요합니다') }
  return objectBody(parsed)
}
