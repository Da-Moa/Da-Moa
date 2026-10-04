import 'server-only'
import { publishInvalidations as publish } from '../websocket-util.mjs'
import type { ResourceKey } from '../../Shared/realtime'

export function realtimeEnabled() { return Boolean(process.env.REALTIME_INTERNAL_SECRET && process.env.REALTIME_INTERNAL_PORT) }

export async function publishInvalidations(publications: { userIds: string[]; keys: ResourceKey[] }[]) {
  if (!realtimeEnabled()) return
  try { await publish(publications) }
  catch { console.error('Realtime invalidation failed') }
}
