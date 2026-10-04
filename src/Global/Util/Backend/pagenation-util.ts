import 'server-only'
import { badInput } from '../../../lib/errors'
import type { Page } from '../../../lib/domain-types'

export function pagination(query: URLSearchParams) {
  const limit = Number(query.get('limit') ?? 20)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) badInput()
  let cursor: { createdAt: string; id: string } | null = null
  if (query.has('cursor')) {
    try {
      const encoded = query.get('cursor')!
      if (encoded.length > 512) throw new Error()
      const value = JSON.parse(Buffer.from(encoded, 'base64url').toString())
      if (!value || typeof value.createdAt !== 'string' || !/^\d+$/.test(value.createdAt) || value.createdAt !== value.createdAt.trim() || value.createdAt.length > 16 || !Number.isSafeInteger(Number(value.createdAt)) || typeof value.id !== 'string' || !/^[\w-]{1,128}$/.test(value.id) || value.id !== value.id.trim()) throw new Error()
      cursor = value
    } catch { badInput('invalid_cursor', '목록을 다시 불러와 주세요') }
  }
  return { limit, cursor }
}

export function pageOf<T>(rows: T[], limit: number, position: (item: T) => { createdAt: number; id: string }): Page<T> {
  const items = rows.slice(0, limit)
  const last = items.at(-1)
  const value = last ? position(last) : null
  return { items, nextCursor: rows.length > limit && value ? Buffer.from(JSON.stringify({ id: value.id, createdAt: String(value.createdAt) })).toString('base64url') : null }
}
