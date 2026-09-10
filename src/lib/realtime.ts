export type ResourceKey = 'me' | 'groups' | 'rounds' | 'settlements'
  | `group:${string}` | `group-rounds:${string}` | `round:${string}` | `settlement:${string}`

export type InvalidateEvent = { type: 'invalidate'; keys: ResourceKey[] }

const keyedResource = /^(group|group-rounds|round|settlement):[\w-]{1,128}$/

function resourceKey(value: unknown): value is ResourceKey {
  return typeof value === 'string' && (['me', 'groups', 'rounds', 'settlements'].includes(value) || keyedResource.test(value))
}

export function parseInvalidateEvent(value: unknown): InvalidateEvent | null {
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return null }
  }
  if (!value || typeof value !== 'object') return null
  const event = value as Record<string, unknown>
  if (event.type !== 'invalidate' || !Array.isArray(event.keys) || !event.keys.length || event.keys.length > 20 || !event.keys.every(resourceKey)) return null
  return { type: 'invalidate', keys: [...new Set(event.keys)] as ResourceKey[] }
}

export function resourceKeysForPath(path: string): ResourceKey[] {
  const parts = path.split('?', 1)[0].split('/').filter(Boolean)
  if (parts[0] !== 'api') return []
  if (parts[1] === 'me' && parts.length === 2) return ['me']
  if (parts[1] === 'groups' && parts.length === 2) return ['groups']
  if (parts[1] === 'groups' && parts[2] && parts.length === 3) return [`group:${parts[2]}`]
  if (parts[1] === 'groups' && parts[2] && parts[3] === 'rounds') return [`group-rounds:${parts[2]}`]
  if (parts[1] === 'rounds' && parts.length === 2) return ['rounds']
  if (parts[1] === 'rounds' && parts[2] && parts[3] === 'settlement') return [`settlement:${parts[2]}`, 'settlements']
  if (parts[1] === 'rounds' && parts[2]) return [`round:${parts[2]}`]
  return []
}

export const realtimeUserChannel = (userId: string) => `da-moa:user:${userId}`
