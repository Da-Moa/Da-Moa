import 'server-only'
import type { Database } from '../../../../Global/Util/Backend'

export async function hasUnfinishedGroupRounds(client: Database, groupId: string): Promise<boolean> {
  return Boolean((await client.query("SELECT 1 FROM rounds WHERE group_id=$1 AND status<>'COMPLETED' LIMIT 1", [groupId])).rows.length)
}

export async function hasUnfinishedGroupParticipation(client: Database, groupId: string, userId: string): Promise<boolean> {
  return Boolean((await client.query(`SELECT 1 FROM rounds r JOIN round_members m ON m.round_id=r.id
    WHERE r.group_id=$1 AND m.user_id=$2 AND m.excluded_at IS NULL AND r.status<>'COMPLETED' LIMIT 1`, [groupId, userId])).rows.length)
}
