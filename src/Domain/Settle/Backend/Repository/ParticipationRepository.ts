import 'server-only'
import type { UnfinishedUserRound } from '../../Shared'
import type { Database } from '../../../../Global/Util/Backend'

export async function hasUnfinishedGroupRounds(client: Database, groupId: string): Promise<boolean> {
  return Boolean((await client.query("SELECT 1 FROM rounds WHERE group_id=$1 AND status<>'COMPLETED' LIMIT 1", [groupId])).rows.length)
}

export async function hasUnfinishedGroupParticipation(client: Database, groupId: string, userId: string): Promise<boolean> {
  return Boolean((await client.query(`SELECT 1 FROM rounds r JOIN round_members m ON m.round_id=r.id
    WHERE r.group_id=$1 AND m.user_id=$2 AND m.excluded_at IS NULL AND r.status<>'COMPLETED' LIMIT 1`, [groupId, userId])).rows.length)
}

export async function getUnfinishedUserRounds(client: Database, userId: string): Promise<UnfinishedUserRound[]> {
  const { rows } = await client.query<UnfinishedUserRound>(`
    SELECT r.id, r.name, r.status, g.id AS "groupId", g.name AS "groupName"
    FROM round_members rm JOIN rounds r ON r.id = rm.round_id JOIN groups g ON g.id = r.group_id
    WHERE rm.user_id = $1 AND r.status <> 'COMPLETED'
    ORDER BY r.created_at, r.id
  `, [userId])
  return rows.map(row => ({ id: row.id, name: row.name, status: row.status, groupId: row.groupId, groupName: row.groupName }))
}
