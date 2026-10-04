import 'server-only'
import { publishInvalidations, realtimeEnabled, type ResourceKey } from '../../../../Global/Websocket/Backend'
import { getDepartureAudience } from '../Service/GroupService'

export function publishGroupInvalidation(groupId: string, userIds: string[] = [], detailOnly = false) {
  const keys: ResourceKey[] = detailOnly ? [`group:${groupId}`] : ['groups', `group:${groupId}`]
  return publishInvalidations([{ userIds, keys }])
}

export async function publishDepartureInvalidation(groupIds: string[]) {
  if (!realtimeEnabled() || !groupIds.length) return
  try {
    const members = await getDepartureAudience(groupIds)
    await publishInvalidations(groupIds.map(groupId => ({ userIds: members.filter(row => row.group_id === groupId).map(row => row.user_id), keys: ['groups', `group:${groupId}`] })))
  } catch { console.error('Realtime departure invalidation failed') }
}
