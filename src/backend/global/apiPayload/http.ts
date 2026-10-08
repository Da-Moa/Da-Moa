import { AppError } from './errors'
import { getKakaoRedirectUris } from '../auth/native'
import type { Request as ExpressRequest } from 'express'

export function requestOrigin(request: Request): URL | null {
  const host = request.headers.get('host') ?? new URL(request.url).host
  const protocol = request.headers.get('x-forwarded-proto')?.split(',')[0].trim() || new URL(request.url).protocol.slice(0, -1)
  return allowedOrigin(host, protocol)
}

function allowedOrigin(host: string, protocol: string): URL | null {
  if (!host || !['http', 'https'].includes(protocol)) return null
  try {
    const origin = new URL(`${protocol}://${host}`)
    if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return null
    if (process.env.NODE_ENV === 'production' && !getKakaoRedirectUris().some(uri => new URL(uri).origin === origin.origin)) return null
    return origin
  } catch { return null }
}

export function sameOrigin(request: Request): boolean {
  const expected = requestOrigin(request)
  return Boolean(expected && request.headers.get('origin') === expected.origin)
}

export function sameNodeOrigin(request: ExpressRequest): boolean {
  const forwarded = request.headers['x-forwarded-proto']
  const protocol = (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '') || request.protocol
  const expected = allowedOrigin(request.headers.host || 'localhost', protocol)
  return Boolean(expected && request.headers.origin === expected.origin)
}

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
