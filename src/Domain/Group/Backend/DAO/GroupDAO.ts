import 'server-only'

export type GroupRow = { id: string; name: string; creator_id: string; created_at: string | number }
export type GroupListRow = GroupRow & { member_ids: string[] }
export type GroupMemberRow = GroupRow & { user_id: string; display_name: string }
export type InviteRow = { id: string; group_id: string; name: string; creator_id: string; expires_at: string | number; is_member: boolean }
export type InviteSummaryRow = { id: string; expires_at: string | number }
