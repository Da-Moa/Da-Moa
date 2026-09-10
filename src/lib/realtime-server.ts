import { Rest, type TokenRequest } from 'ably'
import type { AccessToken } from './auth'
import { getAccount, requireAccount } from './authorization'
import { withReadTransaction } from './db'
import { AppError } from './errors'
import { realtimeUserChannel, type ResourceKey } from './realtime'

export type RoundAudience = { groupId: string; userIds: string[]; groupUserIds?: string[] }
type RoundRecipients = RoundAudience & { groupUserIds: string[] }
type Publication = { userIds: string[]; keys: ResourceKey[] }

let rest: Rest | null = null
let restKey = ''

export function realtimeEnabled() { return Boolean(process.env.ABLY_API_KEY?.trim()) }

function ably() {
  const key = process.env.ABLY_API_KEY?.trim()
  if (!key) throw new AppError(503, 'realtime_unavailable', '실시간 연결을 사용할 수 없습니다')
  if (!rest || key !== restKey) { rest = new Rest(key); restKey = key }
  return rest
}

export async function createRealtimeToken(access: AccessToken | null): Promise<TokenRequest> {
  const account = await getAccount(access)
  return ably().auth.createTokenRequest({ clientId: account.id, ttl: 60 * 60 * 1000, capability: { [realtimeUserChannel(account.id)]: ['subscribe'] } })
}

async function send(publications: Publication[]) {
  if (!realtimeEnabled()) return
  const byUser = new Map<string, Set<ResourceKey>>()
  for (const publication of publications) for (const userId of publication.userIds) {
    const keys = byUser.get(userId) ?? new Set<ResourceKey>()
    publication.keys.forEach(key => keys.add(key)); byUser.set(userId, keys)
  }
  const results = await Promise.allSettled([...byUser].map(([userId, keys]) =>
    ably().channels.get(realtimeUserChannel(userId)).publish('invalidate', { type: 'invalidate', keys: [...keys] })))
  const failed = results.filter(result => result.status === 'rejected').length
  if (failed) console.error(`Realtime invalidation failed for ${failed} recipient(s)`)
}

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

export async function captureGroupAudience(access: AccessToken | null, groupId: string): Promise<string[] | undefined> {
  if (!realtimeEnabled()) return undefined
  return withReadTransaction(async client => {
    const account = await requireAccount(client, access)
    const { rows } = await client.query(`SELECT member.user_id FROM group_members viewer JOIN group_members member ON member.group_id=viewer.group_id AND member.left_at IS NULL
      WHERE viewer.group_id=$1 AND viewer.user_id=$2 AND viewer.left_at IS NULL`, [groupId, account.id])
    return rows.map(row => String(row.user_id))
  })
}

export async function publishRoundInvalidation(roundId: string, includeGroupMembers = false, captured?: RoundAudience | null) {
  if (!realtimeEnabled()) return
  try {
    const audience = captured === undefined ? await roundAudience(roundId, includeGroupMembers) : captured
    if (!audience) return
    const keys: ResourceKey[] = ['rounds', `group-rounds:${audience.groupId}`, `round:${roundId}`, `settlement:${roundId}`]
    const publications: Publication[] = [{ userIds: audience.userIds, keys }]
    if (includeGroupMembers) publications.push({ userIds: [...audience.userIds, ...(audience.groupUserIds ?? [])], keys: ['groups', `group:${audience.groupId}`] })
    await send(publications)
  } catch { console.error('Realtime round invalidation failed') }
}

export async function publishGroupInvalidation(groupId: string, capturedUserIds?: string[]) {
  if (!realtimeEnabled()) return
  try {
    const currentUserIds = await withReadTransaction(async client => {
      const { rows } = await client.query(`SELECT m.user_id FROM group_members m JOIN users u ON u.id=m.user_id
        WHERE m.group_id=$1 AND m.left_at IS NULL AND u.deleted_at IS NULL`, [groupId])
      return rows.map(row => String(row.user_id))
    })
    const users = [...new Set([...(capturedUserIds ?? []), ...currentUserIds])]
    await send([{ userIds: users, keys: ['groups', `group:${groupId}`] }])
  } catch { console.error('Realtime group invalidation failed') }
}

export async function publishBankInvalidation(userId: string) {
  if (!realtimeEnabled()) return
  try {
    const senders = await withReadTransaction(async client => {
      const { rows } = await client.query('SELECT DISTINCT sender_id FROM settlement_transfers WHERE receiver_id=$1', [userId])
      return rows.map(row => String(row.sender_id))
    })
    await send([{ userIds: [userId], keys: ['me'] }, { userIds: senders, keys: ['settlements'] }])
  } catch { console.error('Realtime bank invalidation failed') }
}

export async function publishDepartureInvalidation(groupIds: string[]) {
  if (!realtimeEnabled() || !groupIds.length) return
  try {
    const rows = await withReadTransaction(async client => (await client.query(`SELECT m.group_id,m.user_id FROM group_members m JOIN users u ON u.id=m.user_id
      WHERE m.group_id=ANY($1::text[]) AND m.left_at IS NULL AND u.deleted_at IS NULL`, [groupIds])).rows)
    await send(groupIds.map(groupId => ({ userIds: rows.filter(row => row.group_id === groupId).map(row => String(row.user_id)), keys: ['groups', `group:${groupId}`] })))
  } catch { console.error('Realtime departure invalidation failed') }
}
