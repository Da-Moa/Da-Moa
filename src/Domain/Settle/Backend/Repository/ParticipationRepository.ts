import 'server-only'
import type { UnfinishedUserRound } from '../../Shared'
import type { Database } from '../../../../Global/Util/Backend'

// Public SQL relation: a null user_id still represents an unfinished round for its group creator.
export const unfinishedGroupParticipationSql = `SELECT r.group_id,m.user_id FROM rounds r
  LEFT JOIN round_members m ON m.round_id=r.id AND m.excluded_at IS NULL WHERE r.status<>'COMPLETED'`

export async function hasUnfinishedGroupRounds(client: Database, groupId: string): Promise<boolean> {
  return Boolean((await client.query(`SELECT 1 FROM (${unfinishedGroupParticipationSql}) unfinished WHERE group_id=$1 LIMIT 1`, [groupId])).rows.length)
}

export async function hasUnfinishedGroupParticipation(client: Database, groupId: string, userId: string): Promise<boolean> {
  return Boolean((await client.query(`SELECT 1 FROM (${unfinishedGroupParticipationSql}) unfinished WHERE group_id=$1 AND user_id=$2 LIMIT 1`, [groupId, userId])).rows.length)
}

export const unfinishedUserRoundsSql = `
    SELECT r.id, r.name, r.status, g.id AS "groupId", g.name AS "groupName"
    FROM round_members rm JOIN rounds r ON r.id = rm.round_id JOIN groups g ON g.id = r.group_id
    WHERE rm.user_id = $1 AND r.status <> 'COMPLETED'
    ORDER BY r.created_at, r.id
  `

export async function getUnfinishedUserRounds(client: Database, userId: string): Promise<UnfinishedUserRound[]> {
  const { rows } = await client.query<UnfinishedUserRound>(unfinishedUserRoundsSql, [userId])
  return rows.map(row => ({ id: row.id, name: row.name, status: row.status, groupId: row.groupId, groupName: row.groupName }))
}
