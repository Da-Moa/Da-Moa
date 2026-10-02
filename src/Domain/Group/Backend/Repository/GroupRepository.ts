import 'server-only'
import type { Database } from '../../../../Global/Util/Backend'
import type { GroupRow, GroupListRow, InviteRow, InviteSummaryRow, GroupMemberRow } from '../DAO/GroupDAO'

type Cursor = { createdAt: string; id: string } | null

export async function findGroups(client: Database, userId: string, search: string | null, cursor: Cursor, limit: number) {
  const pattern = search === null ? null : `%${search.replace(/[\\%_]/g, '\\$&')}%`
  return (await client.query<GroupListRow>(`SELECT g.id,g.creator_id,g.name,g.created_at,
    array_agg(member.user_id ORDER BY CASE WHEN member.user_id=g.creator_id THEN 0 ELSE 1 END,member.user_id) AS member_ids
    FROM (
      SELECT g.* FROM groups g
      JOIN group_members viewer ON viewer.group_id=g.id AND viewer.user_id=$1 AND viewer.left_at IS NULL
      WHERE ($2::text IS NULL OR g.name ILIKE $2)
      AND ($3::text IS NULL OR g.id<$3)
      ORDER BY g.id DESC LIMIT $4
    ) g
    JOIN group_members member ON member.group_id=g.id AND member.left_at IS NULL
    GROUP BY g.id,g.creator_id,g.name,g.created_at ORDER BY g.id DESC`, [userId, pattern, cursor?.id ?? null, limit + 1])).rows
}

export async function findMemberGroup(client: Database, groupId: string, userId: string) {
  return (await client.query<GroupRow>(`SELECT g.* FROM groups g JOIN group_members m ON m.group_id=g.id AND m.user_id=$2 AND m.left_at IS NULL WHERE g.id=$1`, [groupId, userId])).rows[0]
}

export async function findGroupWithMembers(client: Database, groupId: string) {
  return (await client.query<GroupMemberRow>(`SELECT g.id,g.creator_id,g.name,g.created_at,m.user_id,COALESCE(u.display_name,'카카오 사용자') AS display_name
    FROM groups g
    JOIN group_members m ON m.group_id=g.id AND m.left_at IS NULL
    JOIN users u ON u.id=m.user_id AND u.deleted_at IS NULL AND u.onboarding_completed_at IS NOT NULL
    WHERE g.id=$1
    ORDER BY CASE WHEN m.user_id=g.creator_id THEN 0 ELSE 1 END,m.user_id`, [groupId])).rows
}

export async function findActiveInvites(client: Database, groupId: string, now: number) {
  return (await client.query<InviteSummaryRow>('SELECT id,expires_at FROM group_invites WHERE group_id=$1 AND revoked_at IS NULL AND expires_at>$2 ORDER BY created_at DESC', [groupId, now])).rows
}

export async function insertGroup(client: Database, id: string, userId: string, name: string, now: number) {
  await client.query(`WITH created_group AS (
    INSERT INTO groups(id,creator_id,name,created_at)
    VALUES($1,$2,$3,$4)
    RETURNING id,creator_id,created_at
  ) INSERT INTO group_members(group_id,user_id,joined_at)
    SELECT id,creator_id,created_at FROM created_group`, [id, userId, name, now])
}

export async function closeGroup(client: Database, groupId: string, now: number) {
  await client.query('UPDATE group_invites SET revoked_at=COALESCE(revoked_at,$2) WHERE group_id=$1', [groupId, now])
  await client.query('UPDATE group_members SET left_at=COALESCE(left_at,$2) WHERE group_id=$1', [groupId, now])
}

export async function leaveGroup(client: Database, groupId: string, userId: string, now: number) {
  await client.query('UPDATE group_members SET left_at=$3 WHERE group_id=$1 AND user_id=$2 AND left_at IS NULL', [groupId, userId, now])
}

export async function revokeInvite(client: Database, groupId: string, inviteId: string, now: number) {
  return (await client.query('UPDATE group_invites SET revoked_at=COALESCE(revoked_at,$3) WHERE id=$1 AND group_id=$2', [inviteId, groupId, now])).rowCount
}

export async function insertInvite(client: Database, id: string, groupId: string, userId: string, tokenHash: string, now: number, expiresAt: number) {
  await client.query('INSERT INTO group_invites(id,group_id,created_by,token_hash,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)', [id, groupId, userId, tokenHash, now, expiresAt])
}

export async function findValidInvite(client: Database, tokenHash: string, userId: string, now: number) {
  return (await client.query<InviteRow>(`SELECT i.id,i.group_id,i.expires_at,g.name,g.creator_id,
    EXISTS(SELECT 1 FROM group_members x WHERE x.group_id=g.id AND x.user_id=$3 AND x.left_at IS NULL) AS is_member
    FROM group_invites i JOIN groups g ON g.id=i.group_id
    JOIN group_members m ON m.group_id=g.id AND m.user_id=g.creator_id AND m.left_at IS NULL
    WHERE i.token_hash=$1 AND i.revoked_at IS NULL AND i.expires_at>$2`, [tokenHash, now, userId])).rows[0]
}

export async function countActiveMembers(client: Database, groupId: string) {
  return Number((await client.query('SELECT COUNT(*)::int AS count FROM group_members WHERE group_id=$1 AND left_at IS NULL', [groupId])).rows[0].count)
}

export async function joinGroup(client: Database, groupId: string, userId: string, now: number) {
  await client.query(`INSERT INTO group_members(group_id,user_id,joined_at) VALUES($1,$2,$3) ON CONFLICT(group_id,user_id)
    DO UPDATE SET joined_at=CASE WHEN group_members.left_at IS NOT NULL THEN EXCLUDED.joined_at ELSE group_members.joined_at END,left_at=NULL`, [groupId, userId, now])
}
