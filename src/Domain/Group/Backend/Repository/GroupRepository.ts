import 'server-only'
import type { Database } from '../../../../Global/Util/Backend'
import type { GroupRow, GroupListRow, InviteRow, InviteSummaryRow, InviteMutationRow, InviteAcceptanceRow, GroupMemberRow, GroupDepartureRow } from '../DAO/GroupDAO'

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

export async function findGroupDeparture(client: Database, groupId: string, userId: string, key: string) {
  return (await client.query<GroupDepartureRow>(`SELECT g.creator_id,viewer.user_id,
    EXISTS(SELECT 1 FROM rounds r WHERE r.group_id=$1 AND r.status<>'COMPLETED'
      AND (g.creator_id=$2 OR EXISTS(SELECT 1 FROM round_members m
        WHERE m.round_id=r.id AND m.user_id=$2 AND m.excluded_at IS NULL))) AS has_unfinished,
    ARRAY(SELECT user_id FROM group_members WHERE group_id=$1 AND left_at IS NULL) AS member_ids,
    previous.request_digest,previous.response_metadata
    FROM (SELECT $1::text AS id) requested
    LEFT JOIN groups g ON g.id=requested.id
    LEFT JOIN group_members viewer ON viewer.group_id=g.id AND viewer.user_id=$2 AND viewer.left_at IS NULL
    LEFT JOIN mutation_requests previous ON previous.actor_id=$2 AND previous.operation='group.leave' AND previous.request_key=$3`, [groupId, userId, key])).rows[0]
}

export async function leaveGroup(client: Database, groupId: string, userId: string, now: number, isCreator: boolean, key: string, digest: string) {
  await client.query(`WITH departed AS (
    UPDATE group_members SET left_at=$3
    WHERE group_id=$1 AND left_at IS NULL AND ($4::boolean OR user_id=$2)
    RETURNING user_id
  ), revoked AS (
    UPDATE group_invites SET revoked_at=$3
    WHERE group_id=$1 AND revoked_at IS NULL AND $4::boolean AND EXISTS(SELECT 1 FROM departed)
    RETURNING id
  ) INSERT INTO mutation_requests(actor_id,operation,request_key,request_digest,resource_id,response_metadata,created_at)
    SELECT $2,'group.leave',$5,$6,$1,jsonb_build_object('id',$1::text),$3
    WHERE EXISTS(SELECT 1 FROM departed)`, [groupId, userId, now, isCreator, key, digest])
}

export async function revokeInvite(client: Database, groupId: string, inviteId: string, now: number, userId: string, key: string, digest: string) {
  return (await client.query(`WITH revoked AS (
    UPDATE group_invites SET revoked_at=COALESCE(revoked_at,$3)
    WHERE id=$1 AND group_id=$2
    RETURNING id
  ) INSERT INTO mutation_requests(actor_id,operation,request_key,request_digest,resource_id,response_metadata,created_at)
    SELECT $4,'invite.revoke',$5,$6,id,jsonb_build_object('id',id),$3 FROM revoked`, [inviteId, groupId, now, userId, key, digest])).rowCount
}

export async function findInviteMutation(client: Database, groupId: string, userId: string, key: string, operation: 'invite.create' | 'invite.revoke') {
  return (await client.query<InviteMutationRow>(`SELECT g.creator_id,m.user_id,previous.request_digest,previous.response_metadata
    FROM (SELECT $1::text AS id) requested
    LEFT JOIN groups g ON g.id=requested.id
    LEFT JOIN group_members m ON m.group_id=g.id AND m.user_id=$2 AND m.left_at IS NULL
    LEFT JOIN mutation_requests previous ON previous.actor_id=$2 AND previous.operation=$4 AND previous.request_key=$3`, [groupId, userId, key, operation])).rows[0]
}

export async function insertInvite(client: Database, id: string, groupId: string, userId: string, tokenHash: string, now: number, expiresAt: number, key: string, digest: string, replaceInviteId: string | null) {
  return (await client.query(`WITH created AS (
    INSERT INTO group_invites(id,group_id,created_by,token_hash,created_at,expires_at)
    SELECT $1,$2,$3,$4,$5,$6 FROM groups g
    JOIN group_members m ON m.group_id=g.id AND m.user_id=$3 AND m.left_at IS NULL
    JOIN users u ON u.id=m.user_id AND u.deleted_at IS NULL AND u.onboarding_completed_at IS NOT NULL
    WHERE g.id=$2 AND g.creator_id=$3
      AND ($9::text IS NULL OR EXISTS(SELECT 1 FROM group_invites WHERE id=$9 AND group_id=$2))
    RETURNING id
  ), revoked AS (
    UPDATE group_invites SET revoked_at=COALESCE(revoked_at,$5)
    WHERE id=$9 AND group_id=$2 AND EXISTS(SELECT 1 FROM created)
    RETURNING id
  ) INSERT INTO mutation_requests(actor_id,operation,request_key,request_digest,resource_id,response_metadata,created_at)
    SELECT $3,'invite.create',$7,$8,id,jsonb_build_object('id',id,'inviteId',id,'linkUnavailable',true),$5
    FROM created`, [id, groupId, userId, tokenHash, now, expiresAt, key, digest, replaceInviteId])).rowCount
}

export async function findValidInvite(client: Database, tokenHash: string, userId: string, now: number) {
  return (await client.query<InviteRow>(`SELECT i.id,i.group_id,i.expires_at,g.name,g.creator_id,
    viewer.user_id IS NOT NULL AS is_member
    FROM group_invites i JOIN groups g ON g.id=i.group_id
    JOIN group_members m ON m.group_id=g.id AND m.user_id=g.creator_id AND m.left_at IS NULL
    JOIN users u ON u.id=m.user_id AND u.deleted_at IS NULL AND u.onboarding_completed_at IS NOT NULL
    LEFT JOIN group_members viewer ON viewer.group_id=g.id AND viewer.user_id=$3 AND viewer.left_at IS NULL
    WHERE i.token_hash=$1 AND i.revoked_at IS NULL AND i.expires_at>$2`, [tokenHash, now, userId])).rows[0]
}

export async function findInviteAcceptance(client: Database, tokenHash: string, userId: string, now: number, key: string) {
  return (await client.query<InviteAcceptanceRow>(`SELECT CASE WHEN u.id IS NOT NULL THEN g.id END AS group_id,
    viewer.user_id IS NOT NULL AS is_member,
    previous.request_digest,previous.response_metadata
    FROM (SELECT $1::text AS token_hash) requested
    LEFT JOIN group_invites i ON i.token_hash=requested.token_hash AND i.revoked_at IS NULL AND i.expires_at>$3
    LEFT JOIN groups g ON g.id=i.group_id
    LEFT JOIN group_members creator ON creator.group_id=g.id AND creator.user_id=g.creator_id AND creator.left_at IS NULL
    LEFT JOIN users u ON u.id=creator.user_id AND u.deleted_at IS NULL AND u.onboarding_completed_at IS NOT NULL
    LEFT JOIN group_members viewer ON viewer.group_id=g.id AND viewer.user_id=$2 AND viewer.left_at IS NULL
    LEFT JOIN mutation_requests previous ON previous.actor_id=$2 AND previous.operation='invite.accept' AND previous.request_key=$4`, [tokenHash, userId, now, key])).rows[0]
}

export async function joinGroup(client: Database, tokenHash: string, userId: string, now: number, key: string, digest: string, memberLimit: number) {
  return (await client.query<{ actor_active: boolean; group_id: string | null; is_member: boolean; member_count: number; member_ids: string[]; joined: boolean }>(`WITH eligible AS (
    SELECT g.id,
      EXISTS(SELECT 1 FROM group_members WHERE group_id=g.id AND user_id=$2 AND left_at IS NULL) AS is_member,
      (SELECT COUNT(*)::int FROM group_members WHERE group_id=g.id AND left_at IS NULL) AS member_count,
      ARRAY(SELECT user_id FROM group_members WHERE group_id=g.id AND left_at IS NULL) AS member_ids
    FROM group_invites i
    JOIN groups g ON g.id=i.group_id
    JOIN group_members creator ON creator.group_id=g.id AND creator.user_id=g.creator_id AND creator.left_at IS NULL
    JOIN users u ON u.id=creator.user_id AND u.deleted_at IS NULL AND u.onboarding_completed_at IS NOT NULL
    WHERE i.token_hash=$1 AND i.revoked_at IS NULL AND i.expires_at>$3
  ), actor AS (
    SELECT id FROM users WHERE id=$2 AND deleted_at IS NULL AND onboarding_completed_at IS NOT NULL
  ), joined AS (
    INSERT INTO group_members(group_id,user_id,joined_at)
    SELECT eligible.id,actor.id,$3 FROM eligible CROSS JOIN actor
    WHERE NOT eligible.is_member AND eligible.member_count<$6
    ON CONFLICT(group_id,user_id) DO UPDATE SET joined_at=EXCLUDED.joined_at,left_at=NULL
      WHERE group_members.left_at IS NOT NULL
    RETURNING group_id
  ), saved AS (
    INSERT INTO mutation_requests(actor_id,operation,request_key,request_digest,resource_id,response_metadata,created_at)
    SELECT $2,'invite.accept',$4,$5,group_id,jsonb_build_object('id',group_id),$3 FROM joined
    RETURNING resource_id
  ) SELECT EXISTS(SELECT 1 FROM actor) AS actor_active,
    (SELECT id FROM eligible) AS group_id,
    COALESCE((SELECT is_member FROM eligible),false) AS is_member,
    COALESCE((SELECT member_count FROM eligible),0) AS member_count,
    COALESCE((SELECT member_ids FROM eligible),'{}'::text[]) AS member_ids,
    EXISTS(SELECT 1 FROM saved) AS joined`, [tokenHash, userId, now, key, digest, memberLimit])).rows[0]
}

// Composed with the User-owned withdrawn CTE so both updates commit in one statement.
export const endUserMembershipsSql = `
  UPDATE group_members SET left_at = $2
  WHERE user_id = $1 AND left_at IS NULL AND EXISTS(SELECT 1 FROM withdrawn)
  RETURNING group_id
`

// Parameters: $1 groupId, $2 participantIds, $4 actorId. Composed by Settle's single INSERT statement.
export const roundCreationCandidatesSql = `WITH actor AS (
    SELECT u.id,m.user_id IS NOT NULL AS is_member FROM users u
    LEFT JOIN group_members m ON m.user_id=u.id AND m.group_id=$1 AND m.left_at IS NULL
    WHERE u.id=$4 AND u.deleted_at IS NULL AND u.onboarding_completed_at IS NOT NULL
  ), candidates AS (
    SELECT u.id,COALESCE(u.display_name,'카카오 사용자') AS name
    FROM group_members m JOIN users u ON u.id=m.user_id
    WHERE m.group_id=$1 AND m.user_id=ANY($2::text[]) AND m.left_at IS NULL
      AND u.deleted_at IS NULL AND u.onboarding_completed_at IS NOT NULL
  )`
