import 'server-only'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { requireAccount } from '../../../../Global/Auth/Backend'
import { badInput, domainMutation, nowSeconds, onlyKeys, pageOf, pagination, textInput, withDatabaseConnection, withReadTransaction, type Database, type Identity } from '../../../../Global/Util/Backend'
import { getActiveUserProfiles } from '../../../User/Backend'
import { hasUnfinishedGroupParticipation, hasUnfinishedGroupRounds } from '../../../Settle/Backend'
import { MAX_GROUP_MEMBERS, type GroupDetail, type GroupMember, type GroupListItem, type GroupSummary, type InvitePreview, type GroupMutationResult, type CreateGroupRequestDTO, type CreateInviteRequestDTO } from '../../Shared'
import type { Page } from '../../../../lib/domain-types'
import type { GroupRow } from '../DAO/GroupDAO'
import { creatorOnly, duplicateGroup, memberLimitExceeded, missing, unfinishedGroupRounds, unfinishedRounds } from '../Exception/GroupException'
import * as repository from '../Repository/GroupRepository'

function groupDTO(row: GroupRow): GroupSummary {
  return { id: row.id, name: row.name, creatorId: row.creator_id, createdAt: Number(row.created_at) }
}

async function memberGroup(client: Database, groupId: string, userId: string, owner = false) {
  const row = await repository.findMemberGroup(client, groupId, userId)
  if (!row) throw missing()
  if (owner && row.creator_id !== userId) throw creatorOnly()
  return row
}

export async function requireGroupMembership(client: Database, groupId: string, userId: string): Promise<GroupSummary> {
  return groupDTO(await memberGroup(client, groupId, userId))
}

async function activeMembers(client: Database, groupIds: string[]) {
  const memberships = await repository.findActiveMemberships(client, groupIds)
  const profiles = new Map((await getActiveUserProfiles(client, [...new Set(memberships.map(member => member.user_id))])).map(profile => [profile.userId, profile]))
  return memberships.flatMap(member => {
    const profile = profiles.get(member.user_id)
    return profile ? [{ groupId: member.group_id, ...profile }] : []
  })
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
    const group = await memberGroup(client, groupId, account.id)
    const invites = group.creator_id === account.id ? await repository.findActiveInvites(client, groupId, nowSeconds()) : []
    return { ...groupDTO(group), isCreator: group.creator_id === account.id, invites: invites.map(row => ({ id: row.id, expiresAt: Number(row.expires_at) })) }
  })
}

export async function getGroupMembers(access: Identity, groupId: string): Promise<GroupMember[]> {
  return withReadTransaction(async client => {
    const account = await requireAccount(client, access)
    await memberGroup(client, groupId, account.id)
    return (await activeMembers(client, [groupId])).map(member => ({ userId: member.userId, displayName: member.displayName, excludedAt: null }))
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

async function closeGroup(client: Database, groupId: string) {
  if (await hasUnfinishedGroupRounds(client, groupId)) throw unfinishedGroupRounds()
  await repository.closeGroup(client, groupId, nowSeconds())
}

async function leaveMembership(client: Database, groupId: string, userId: string) {
  if (await hasUnfinishedGroupParticipation(client, groupId, userId)) throw unfinishedRounds()
  await repository.leaveGroup(client, groupId, userId, nowSeconds())
}

export async function leaveGroup(access: Identity, key: string, groupId: string): Promise<GroupMutationResult> {
  return domainMutation(access, key, 'group.leave', { groupId }, async (client, userId) => {
    const group = await memberGroup(client, groupId, userId)
    if (group.creator_id === userId) await closeGroup(client, groupId)
    else await leaveMembership(client, groupId, userId)
    return { id: groupId }
  })
}

export async function createInvite(access: Identity, key: string, groupId: string, body: CreateInviteRequestDTO | Record<string, unknown>): Promise<GroupMutationResult> {
  onlyKeys(body, ['replaceInviteId'])
  if (body.replaceInviteId !== undefined) textInput(body.replaceInviteId, 128)
  let sharePath: string | undefined
  const result = await domainMutation(access, key, 'invite.create', { groupId, ...body }, async (client, userId) => {
    await memberGroup(client, groupId, userId, true)
    const id = randomUUID(), token = randomBytes(32).toString('base64url'), now = nowSeconds()
    if (body.replaceInviteId && !await repository.revokeInvite(client, groupId, String(body.replaceInviteId), now)) throw missing()
    await repository.insertInvite(client, id, groupId, userId, createHash('sha256').update(token).digest('hex'), now, now + 7 * 86400)
    sharePath = `/invites/${token}`
    return { id, inviteId: id, linkUnavailable: true }
  })
  return sharePath ? { id: result.id, inviteId: result.inviteId, sharePath } : result
}

export async function revokeInvite(access: Identity, key: string, groupId: string, inviteId: string): Promise<GroupMutationResult> {
  return domainMutation(access, key, 'invite.revoke', { groupId, inviteId }, async (client, userId) => {
    await memberGroup(client, groupId, userId, true)
    if (!await repository.revokeInvite(client, groupId, inviteId, nowSeconds())) throw missing()
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
