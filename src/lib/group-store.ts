import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { AccessToken } from './auth'
import { requireAccount } from './authorization'
import { withReadTransaction, withWriteTransaction, type Database } from './db'
import { AppError, badInput } from './errors'
import { replayMutation, saveMutation } from './mutations'
import { MAX_GROUP_MEMBERS, type GroupDetail, type GroupSummary, type MutationResult, type Page } from './domain-types'

export type Identity = AccessToken | null
export const nowSeconds = () => Math.floor(Date.now() / 1000)
export const missing = () => new AppError(404, 'not_found', '요청한 자료를 찾을 수 없어요')

export function textInput(value: unknown, max = 100): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) badInput()
  return value.trim()
}

export function onlyKeys(body: Record<string, unknown>, keys: string[]) {
  if (Object.keys(body).some(key => !keys.includes(key))) badInput('invalid_input', '지원하지 않는 입력 항목이 있어요')
}

export function idsInput(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.some(id => typeof id !== 'string' || id !== id.trim() || !/^[\w-]{1,128}$/.test(id)) || new Set(value).size !== value.length) {
    badInput('invalid_participants', '참여자를 중복 없이 선택해 주세요')
  }
  return (value as string[]).slice().sort()
}

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

export async function ownerGroup(client: Database, groupId: string, userId: string, owner = true) {
  const { rows } = await client.query(`SELECT g.* FROM groups g JOIN group_members m ON m.group_id=g.id AND m.user_id=$2 AND m.left_at IS NULL WHERE g.id=$1`, [groupId, userId])
  if (!rows[0]) throw missing()
  if (owner && rows[0].creator_id !== userId) throw new AppError(403, 'forbidden', '모임 생성자만 할 수 있어요')
  return rows[0]
}

export async function domainMutation(access: Identity, key: string, operation: string, payload: unknown, work: (client: Database, userId: string) => Promise<MutationResult>): Promise<MutationResult> {
  return withWriteTransaction(async client => {
    const account = await requireAccount(client, access)
    const replay = await replayMutation<MutationResult>(client, account.id, operation, key, payload)
    if (replay.result) return replay.result
    const result = await work(client, account.id)
    const stored = result.inviteId ? { id: result.id, inviteId: result.inviteId, linkUnavailable: true } : result
    await saveMutation(client, account.id, operation, key, replay.digest, result.id, stored)
    return result
  })
}

function groupDTO(row: Record<string, any>): GroupSummary {
  return { id: row.id, name: row.name, creatorId: row.creator_id, createdAt: Number(row.created_at) }
}

export async function listGroups(access: Identity, query: URLSearchParams): Promise<Page<GroupSummary>> {
  const { limit, cursor } = pagination(query)
  return withReadTransaction(async client => {
    const account = await requireAccount(client, access)
    const { rows } = await client.query(`SELECT g.* FROM groups g JOIN group_members m ON m.group_id=g.id AND m.user_id=$1 AND m.left_at IS NULL
      WHERE ($2::bigint IS NULL OR (g.created_at,g.id)<($2::bigint,$3::text)) ORDER BY g.created_at DESC,g.id DESC LIMIT $4`, [account.id, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1])
    return pageOf(rows.map(groupDTO), limit, row => row)
  })
}

export async function getGroup(access: Identity, groupId: string): Promise<GroupDetail> {
  return withReadTransaction(async client => {
    const account = await requireAccount(client, access)
    const group = await ownerGroup(client, groupId, account.id, false)
    const { rows: members } = await client.query(`SELECT u.id AS "userId",COALESCE(u.display_name,'카카오 사용자') AS "displayName",NULL AS "excludedAt"
      FROM group_members m JOIN users u ON u.id=m.user_id WHERE m.group_id=$1 AND m.left_at IS NULL AND u.deleted_at IS NULL AND u.onboarding_completed_at IS NOT NULL
      ORDER BY CASE WHEN u.id=$2 THEN 0 ELSE 1 END,u.id`, [groupId, group.creator_id])
    const { rows: invites } = group.creator_id === account.id ? await client.query('SELECT id,expires_at FROM group_invites WHERE group_id=$1 AND revoked_at IS NULL AND expires_at>$2 ORDER BY created_at DESC', [groupId, nowSeconds()]) : { rows: [] }
    return { ...groupDTO(group), isCreator: group.creator_id === account.id, members, invites: invites.map(row => ({ id: row.id, expiresAt: Number(row.expires_at) })) }
  })
}

export async function createGroup(access: Identity, key: string, body: Record<string, unknown>) {
  onlyKeys(body, ['name'])
  const name = textInput(body.name)
  return domainMutation(access, key, 'group.create', body, async (client, userId) => {
    const id = randomUUID(), now = nowSeconds()
    await client.query('INSERT INTO groups(id,creator_id,name,created_at) VALUES($1,$2,$3,$4)', [id, userId, name, now])
    await client.query('INSERT INTO group_members(group_id,user_id,joined_at) VALUES($1,$2,$3)', [id, userId, now])
    return { id }
  })
}

export async function leaveGroup(access: Identity, key: string, groupId: string) {
  return domainMutation(access, key, 'group.leave', { groupId }, async (client, userId) => {
    const group = await ownerGroup(client, groupId, userId, false)
    if (group.creator_id === userId) {
      const { rows } = await client.query("SELECT 1 FROM rounds WHERE group_id=$1 AND status<>'COMPLETED' LIMIT 1", [groupId])
      if (rows.length) throw new AppError(409, 'unfinished_group_rounds', '종료되지 않은 회차가 있어 모임을 없앨 수 없어요')
      const now = nowSeconds()
      await client.query('UPDATE group_invites SET revoked_at=COALESCE(revoked_at,$2) WHERE group_id=$1', [groupId, now])
      await client.query('UPDATE group_members SET left_at=COALESCE(left_at,$2) WHERE group_id=$1', [groupId, now])
    } else {
      const { rows } = await client.query(`SELECT 1 FROM rounds r JOIN round_members m ON m.round_id=r.id
        WHERE r.group_id=$1 AND m.user_id=$2 AND m.excluded_at IS NULL AND r.status<>'COMPLETED' LIMIT 1`, [groupId, userId])
      if (rows.length) throw new AppError(409, 'unfinished_rounds', '참여 중인 회차가 있어 모임에서 나갈 수 없어요')
      await client.query('UPDATE group_members SET left_at=$3 WHERE group_id=$1 AND user_id=$2 AND left_at IS NULL', [groupId, userId, nowSeconds()])
    }
    return { id: groupId }
  })
}

export async function createInvite(access: Identity, key: string, groupId: string, body: Record<string, unknown>) {
  onlyKeys(body, ['replaceInviteId'])
  if (body.replaceInviteId !== undefined) textInput(body.replaceInviteId, 128)
  return domainMutation(access, key, 'invite.create', { groupId, ...body }, async (client, userId) => {
    await ownerGroup(client, groupId, userId)
    const id = randomUUID(), token = randomBytes(32).toString('base64url'), now = nowSeconds()
    if (body.replaceInviteId) {
      const { rowCount } = await client.query('UPDATE group_invites SET revoked_at=COALESCE(revoked_at,$3) WHERE id=$1 AND group_id=$2', [body.replaceInviteId, groupId, now])
      if (!rowCount) throw missing()
    }
    await client.query('INSERT INTO group_invites(id,group_id,created_by,token_hash,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)', [id, groupId, userId, createHash('sha256').update(token).digest('hex'), now, now + 7 * 86400])
    return { id, inviteId: id, sharePath: `/invites/${token}` }
  })
}

export async function revokeInvite(access: Identity, key: string, groupId: string, inviteId: string) {
  return domainMutation(access, key, 'invite.revoke', { groupId, inviteId }, async (client, userId) => {
    await ownerGroup(client, groupId, userId)
    const { rowCount } = await client.query('UPDATE group_invites SET revoked_at=COALESCE(revoked_at,$3) WHERE id=$1 AND group_id=$2', [inviteId, groupId, nowSeconds()])
    if (!rowCount) throw missing()
    return { id: inviteId }
  })
}

async function validInvite(client: Database, token: string, userId: string) {
  if (!/^[\w-]{43}$/.test(token)) throw missing()
  const { rows } = await client.query(`SELECT i.*,g.name,
    EXISTS(SELECT 1 FROM group_members x WHERE x.group_id=g.id AND x.user_id=$3 AND x.left_at IS NULL) AS is_member
    FROM group_invites i JOIN groups g ON g.id=i.group_id JOIN users u ON u.id=g.creator_id
    JOIN group_members m ON m.group_id=g.id AND m.user_id=g.creator_id AND m.left_at IS NULL
    WHERE i.token_hash=$1 AND i.revoked_at IS NULL AND i.expires_at>$2 AND u.deleted_at IS NULL AND u.onboarding_completed_at IS NOT NULL`, [createHash('sha256').update(token).digest('hex'), nowSeconds(), userId])
  if (!rows[0]) throw missing()
  return rows[0]
}

export async function getInvite(access: Identity, token: string) {
  return withReadTransaction(async client => {
    const account = await requireAccount(client, access)
    const row = await validInvite(client, token, account.id)
    return { groupId: row.group_id, groupName: row.name, isMember: row.is_member, expiresAt: Number(row.expires_at) }
  })
}

export async function acceptInvite(access: Identity, key: string, token: string) {
  return domainMutation(access, key, 'invite.accept', { tokenHash: createHash('sha256').update(token).digest('hex') }, async (client, userId) => {
    const row = await validInvite(client, token, userId)
    if (!row.is_member) {
      const { rows } = await client.query('SELECT COUNT(*)::int AS count FROM group_members WHERE group_id=$1 AND left_at IS NULL', [row.group_id])
      if (Number(rows[0].count) >= MAX_GROUP_MEMBERS) throw new AppError(409, 'group_member_limit_exceeded', `모임은 생성자를 포함해 최대 ${MAX_GROUP_MEMBERS}명까지 참여할 수 있어요`)
    }
    await client.query(`INSERT INTO group_members(group_id,user_id,joined_at) VALUES($1,$2,$3) ON CONFLICT(group_id,user_id)
      DO UPDATE SET joined_at=CASE WHEN group_members.left_at IS NOT NULL THEN EXCLUDED.joined_at ELSE group_members.joined_at END,left_at=NULL`, [row.group_id, userId, nowSeconds()])
    return { id: row.group_id }
  })
}
