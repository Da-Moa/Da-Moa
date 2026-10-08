
export { MAX_GROUP_MEMBERS } from '../../../../../shared/domain/group/constants'
export type GroupMember = { userId: string; displayName: string; excludedAt: number | null }
export type GroupSummary = { id: string; name: string; creatorId: string; createdAt: number }
export type GroupListItem = GroupSummary & { memberCount: number; memberPreview: { userId: string; displayName: string; profileImageUrl: string | null }[] }
export type GroupDetail = GroupSummary & { members: GroupMember[]; isCreator: boolean; invites: { id: string; expiresAt: number }[] }
export type InvitePreview = { groupId: string; groupName: string; isMember: boolean; expiresAt: number }

export type GroupMutationResult = { id: string; inviteId?: string; sharePath?: string; linkUnavailable?: boolean }

export type { CreateGroupRequestDTO, CreateInviteRequestDTO } from '../req/group.request.dto'
