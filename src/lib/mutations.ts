import { createHash } from 'node:crypto'
import type { Database } from './db'
import { AppError } from './errors'

export function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, 'invalid_input', '입력값을 확인해 주세요')
  return value as Record<string, unknown>
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
  return value
}

export async function replayMutation<T>(client: Database, actorId: string, operation: string, key: string, payload: unknown): Promise<{ digest: string; result: T | null }> {
  if (key !== key.trim() || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) {
    throw new AppError(400, 'invalid_request_key', '올바른 요청 키가 필요합니다')
  }
  const digest = createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex')
  const { rows } = await client.query('SELECT request_digest, response_metadata FROM mutation_requests WHERE actor_id=$1 AND operation=$2 AND request_key=$3', [actorId, operation, key])
  if (rows[0] && rows[0].request_digest !== digest) throw new AppError(409, 'idempotency_conflict', '같은 요청 키로 다른 내용을 저장할 수 없어요')
  return { digest, result: rows[0]?.response_metadata as T ?? null }
}

export async function saveMutation(client: Database, actorId: string, operation: string, key: string, digest: string, resourceId: string, result: unknown) {
  await client.query('INSERT INTO mutation_requests(actor_id,operation,request_key,request_digest,resource_id,response_metadata,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [actorId, operation, key, digest, resourceId, JSON.stringify(result), Math.floor(Date.now() / 1000)])
}
