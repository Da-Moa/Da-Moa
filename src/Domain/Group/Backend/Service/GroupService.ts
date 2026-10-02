import 'server-only'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { requireAccount } from '../../../../Global/Auth/Backend'
import { badInput, domainMutation, nowSeconds, onlyKeys, pageOf, pagination, textInput, withDatabaseConnection, withReadTransaction, withWriteTransaction, type Database, type Identity } from '../../../../Global/Util/Backend'
import { mutationDigest, mutationResult } from '../../../../lib/mutations'
import { getActiveUserProfiles } from '../../../User/Backend'
import { MAX_GROUP_MEMBERS, type GroupDetail, type GroupListItem, type GroupSummary, type InvitePreview, type GroupMutationResult, type CreateGroupRequestDTO, type CreateInviteRequestDTO } from '../../Shared'
import type { Page } from '../../../../lib/domain-types'
import type { GroupRow } from '../DAO/GroupDAO'
import { creatorOnly, duplicateGroup, memberLimitExceeded, missing, unfinishedGroupRounds, unfinishedRounds } from '../Exception/GroupException'
import * as repository from '../Repository/GroupRepository'

function groupDTO(row: GroupRow): GroupSummary {
  return { id: row.id, name: row.name, creatorId: row.creator_id, createdAt: Number(row.created_at) }
}

async function memberGroup(client: Database, groupId: string, userId: string) {
  const row = await repository.findMemberGroup(client, groupId, userId)
  if (!row) throw missing()
  return row
}

export async function requireGroupMembership(client: Database, groupId: string, userId: string): Promise<GroupSummary> {
  return groupDTO(await memberGroup(client, groupId, userId))
}

export async function listGroups(access: Identity, query: URLSearchParams): Promise<Page<GroupListItem>> {
  const { limit, cursor } = pagination(query)
  const search = query.has('q') ? textInput(query.get('q'), 100) : null
  return withDatabaseConnection(async client => {
    const account = await requireAccount(client, access)
    const page = pageOf(await repository.findGroups(client, account.id, search, cursor, limit), limit, groupDTO)
    if (!page.items.length) return { ...page, items: [] }
    const memberIds = new Set(page.items.flatMap(group => group.member_ids))
    const profiles = new Map((await getActiveUserProfiles(client, [...memberIds])).map(profile => [profile.userId, profile]))
    return { ...page, items: page.items.map(group => {
      const members = group.member_ids.flatMap(id => { const profile = profiles.get(id); return profile ? [profile] : [] })
      return { ...groupDTO(group), memberCount: members.length, memberPreview: members.slice(0, 5) }
    }) }
  })
}

export async function getGroup(access: Identity, groupId: string): Promise<GroupDetail> {
  return withDatabaseConnection(async client => {
    const account = await requireAccount(client, access)
    const rows = await repository.findGroupWithMembers(client, groupId)
    if (!rows.some(row => row.user_id === account.id)) throw missing()
    const group = rows[0]
    const members = rows.map(row => ({ userId: row.user_id, displayName: row.display_name, excludedAt: null }))
    const invites = group.creator_id === account.id ? await repository.findActiveInvites(client, groupId, nowSeconds()) : []
    return { ...groupDTO(group), isCreator: group.creator_id === account.id, members, invites: invites.map(row => ({ id: row.id, expiresAt: Number(row.expires_at) })) }
  })
}

export async function createGroup(access: Identity, key: string, body: CreateGroupRequestDTO | Record<string, unknown>): Promise<GroupMutationResult> {
  onlyKeys(body, ['name'])
  const name = textInput(body.name)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) badInput('invalid_request_key', 'UUIDv7 모임 생성 키가 필요합니다')
  const id = key.toLowerCase()
  return withDatabaseConnection(async client => {
    const account = await requireAccount(client, access)
    try { await repository.insertGroup(client, id, account.id, name, nowSeconds()) }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505' && 'constraint' in error && error.constraint === 'groups_pkey') throw duplicateGroup()
      throw error
    }
    return { id }
  })
}

export async function leaveGroup(access: Identity, key: string, groupId: string, captureAudience?: (userIds: string[]) => void): Promise<GroupMutationResult> {
  let audience: string[] = []
  let userId: string
  const result = await withWriteTransaction(async client => {
    const digest = mutationDigest(key, { groupId })
    const group = await repository.findGroupDeparture(client, groupId, userId, key)
    audience = group.member_ids
    const replay = mutationResult<GroupMutationResult>(group, digest)
    if (replay) return replay
    if (!group.user_id) throw missing()
    const isCreator = group.creator_id === userId
    if (group.has_unfinished) throw isCreator ? unfinishedGroupRounds() : unfinishedRounds()
    await repository.leaveGroup(client, groupId, userId, nowSeconds(), isCreator, key, digest)
    return { id: groupId }
  }, async client => { userId = (await requireAccount(client, access)).id })
  captureAudience?.(audience)
  return result
}

export async function createInvite(access: Identity, key: string, groupId: string, body: CreateInviteRequestDTO | Record<string, unknown>, captureAudience?: (userIds: string[]) => void): Promise<GroupMutationResult> {
  onlyKeys(body, ['replaceInviteId'])
  if (body.replaceInviteId !== undefined) textInput(body.replaceInviteId, 128)
  return withDatabaseConnection(async client => {
    const account = await requireAccount(client, access)
    const digest = mutationDigest(key, { groupId, ...body })
    const group = await repository.findInviteMutation(client, groupId, account.id, key, 'invite.create')
    const replay = mutationResult<GroupMutationResult>(group, digest)
    captureAudience?.([account.id])
    if (replay) return replay
    if (!group.user_id) throw missing()
    if (group.creator_id !== account.id) throw creatorOnly()
    const id = randomUUID(), token = randomBytes(32).toString('base64url'), now = nowSeconds()
    try {
      if (!await repository.insertInvite(client, id, groupId, account.id, createHash('sha256').update(token).digest('hex'), now, now + 7 * 86400, key, digest, body.replaceInviteId ? String(body.replaceInviteId) : null)) throw missing()
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505' && 'constraint' in error && error.constraint === 'mutation_requests_pkey') {
        const concurrent = mutationResult<GroupMutationResult>(await repository.findInviteMutation(client, groupId, account.id, key, 'invite.create'), digest)
        if (concurrent) return concurrent
      }
      throw error
    }
    return { id, inviteId: id, sharePath: `/invites/${token}` }
  })
}

export async function revokeInvite(access: Identity, key: string, groupId: string, inviteId: string, captureAudience?: (userIds: string[]) => void): Promise<GroupMutationResult> {
  return withDatabaseConnection(async client => {
    const account = await requireAccount(client, access)
    const digest = mutationDigest(key, { groupId, inviteId })
    const group = await repository.findInviteMutation(client, groupId, account.id, key, 'invite.revoke')
    const replay = mutationResult<GroupMutationResult>(group, digest)
    captureAudience?.([account.id])
    if (replay) return replay
    if (!group.user_id) throw missing()
    if (group.creator_id !== account.id) throw creatorOnly()
    try {
      if (!await repository.revokeInvite(client, groupId, inviteId, nowSeconds(), account.id, key, digest)) throw missing()
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505' && 'constraint' in error && error.constraint === 'mutation_requests_pkey') {
        const concurrent = mutationResult<GroupMutationResult>(await repository.findInviteMutation(client, groupId, account.id, key, 'invite.revoke'), digest)
        if (concurrent) return concurrent
      }
      throw error
    }
    return { id: inviteId }
  })
}

async function validInvite(client: Database, token: string, userId: string) {
  if (!/^[\w-]{43}$/.test(token)) throw missing()
  const row = await repository.findValidInvite(client, createHash('sha256').update(token).digest('hex'), userId, nowSeconds())
  if (!row || !(await getActiveUserProfiles(client, [row.creator_id])).length) throw missing()
  return row
}

export async function getInvite(access: Identity, token: string): Promise<InvitePreview> {
  return withReadTransaction(async client => {
    const account = await requireAccount(client, access)
    const row = await validInvite(client, token, account.id)
    return { groupId: row.group_id, groupName: row.name, isMember: row.is_member, expiresAt: Number(row.expires_at) }
  })
}

export async function acceptInvite(access: Identity, key: string, token: string): Promise<GroupMutationResult> {
  return domainMutation(access, key, 'invite.accept', { tokenHash: createHash('sha256').update(token).digest('hex') }, async (client, userId) => {
    const row = await validInvite(client, token, userId)
    if (!row.is_member && await repository.countActiveMembers(client, row.group_id) >= MAX_GROUP_MEMBERS) throw memberLimitExceeded()
    await repository.joinGroup(client, row.group_id, userId, nowSeconds())
    return { id: row.group_id }
  })
}
