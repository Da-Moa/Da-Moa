import { createHash } from 'node:crypto'
import { isUUID } from 'class-validator'
import { AppError } from '../apiPayload/errors'

export function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, 'invalid_input', '입력값을 확인해 주세요')
  return value as Record<string, unknown>
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
  return value
}

export function mutationDigest(key: string, payload: unknown): string {
  if (key !== key.trim() || !isUUID(key, ['1', '2', '3', '4', '5', '6', '7', '8'])) {
    throw new AppError(400, 'invalid_request_key', '올바른 요청 키가 필요합니다')
  }
  return createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex')
}

export function mutationResult<T>(row: { request_digest: string | null; response_metadata: unknown } | undefined, digest: string): T | null {
  if (row?.request_digest && row.request_digest !== digest) throw new AppError(409, 'idempotency_conflict', '같은 요청 키로 다른 내용을 저장할 수 없어요')
  return row?.response_metadata as T ?? null
}
