import 'server-only'
import { publishInvalidations } from '../websocket-util.mjs'
import type { AccessToken } from '../../../../lib/auth'
import { requireAccount } from '../../../../lib/authorization'
import { withReadTransaction } from '../../../../lib/db'
import type { ResourceKey } from '../../Shared/realtime'

export type RoundAudience = { groupId: string; userIds: string[]; groupUserIds?: string[] }
type RoundRecipients = RoundAudience & { groupUserIds: string[] }

export function realtimeEnabled() { return Boolean(process.env.REALTIME_INTERNAL_SECRET && process.env.REALTIME_INTERNAL_PORT) }

async function roundAudience(roundId: string, includeGroupMembers: boolean): Promise<RoundRecipients | null> {
  return withReadTransaction(async client => {
    const { rows: rounds } = await client.query('SELECT group_id FROM rounds WHERE id=$1', [roundId])
    if (!rounds[0]) return null
    const { rows: members } = await client.query('SELECT user_id FROM round_members WHERE round_id=$1', [roundId])
    const groupMembers = includeGroupMembers ? (await client.query(`SELECT m.user_id FROM group_members m JOIN users u ON u.id=m.user_id
      WHERE m.group_id=$1 AND m.left_at IS NULL AND u.deleted_at IS NULL`, [rounds[0].group_id])).rows : []
    return { groupId: rounds[0].group_id, userIds: members.map(row => String(row.user_id)), groupUserIds: groupMembers.map(row => String(row.user_id)) }
  })
}

export async function captureRoundAudience(access: AccessToken | null, roundId: string): Promise<RoundAudience | null> {
  if (!realtimeEnabled()) return null
  return withReadTransaction(async client => {
    const account = await requireAccount(client, access)
    const { rows: rounds } = await client.query(`SELECT r.group_id FROM rounds r JOIN round_members viewer ON viewer.round_id=r.id AND viewer.user_id=$2 WHERE r.id=$1`, [roundId, account.id])
    if (!rounds[0]) return null
    const { rows } = await client.query('SELECT user_id FROM round_members WHERE round_id=$1', [roundId])
    return { groupId: rounds[0].group_id, userIds: rows.map(row => String(row.user_id)) }
  })
}

export async function publishRoundInvalidation(roundId: string, includeGroupMembers = false, captured?: RoundAudience | null) {
  if (!realtimeEnabled()) return
  try {
    const audience = captured === undefined ? await roundAudience(roundId, includeGroupMembers) : captured
    if (!audience) return
    const keys: ResourceKey[] = ['rounds', `group-rounds:${audience.groupId}`, `round:${roundId}`, `settlement:${roundId}`]
    const publications: { userIds: string[]; keys: ResourceKey[] }[] = [{ userIds: audience.userIds, keys }]
    if (includeGroupMembers) publications.push({ userIds: [...audience.userIds, ...(audience.groupUserIds ?? [])], keys: ['groups', `group:${audience.groupId}`] })
    await publishInvalidations(publications)
  } catch { console.error('Realtime round invalidation failed') }
}

export async function publishGroupInvalidation(groupId: string, capturedUserIds?: string[]) {
  if (!realtimeEnabled()) return
  try {
    const users = capturedUserIds ?? await withReadTransaction(async client => {
      const { rows } = await client.query(`SELECT m.user_id FROM group_members m JOIN users u ON u.id=m.user_id
        WHERE m.group_id=$1 AND m.left_at IS NULL AND u.deleted_at IS NULL`, [groupId])
      return rows.map(row => String(row.user_id))
    })
    await publishInvalidations([{ userIds: users, keys: ['groups', `group:${groupId}`] }])
  } catch { console.error('Realtime group invalidation failed') }
}

export async function publishBankInvalidation(userId: string) {
  if (!realtimeEnabled()) return
  try {
    const senders = await withReadTransaction(async client => {
      const { rows } = await client.query('SELECT DISTINCT sender_id FROM settlement_transfers WHERE receiver_id=$1', [userId])
      return rows.map(row => String(row.sender_id))
    })
    await publishInvalidations([{ userIds: [userId], keys: ['me'] }, { userIds: senders, keys: ['settlements'] }])
  } catch { console.error('Realtime bank invalidation failed') }
}

export async function publishDepartureInvalidation(groupIds: string[]) {
  if (!realtimeEnabled() || !groupIds.length) return
  try {
    const rows = await withReadTransaction(async client => (await client.query(`SELECT m.group_id,m.user_id FROM group_members m JOIN users u ON u.id=m.user_id
      WHERE m.group_id=ANY($1::text[]) AND m.left_at IS NULL AND u.deleted_at IS NULL`, [groupIds])).rows)
    await publishInvalidations(groupIds.map(groupId => ({ userIds: rows.filter(row => row.group_id === groupId).map(row => String(row.user_id)), keys: ['groups', `group:${groupId}`] })))
  } catch { console.error('Realtime departure invalidation failed') }
}
