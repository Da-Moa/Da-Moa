import type { UnfinishedUserRound } from '../../../../shared/domain/settle';
import type { Database } from '../../../global/util';
import { rawRows } from '../../../global/database/rawSql';

// Public SQL relation: a null user_id still represents an unfinished round for its group creator.
export const unfinishedGroupParticipationSql = `SELECT r.group_id,m.user_id FROM rounds r
  LEFT JOIN round_members m ON m.round_id=r.id AND m.excluded_at IS NULL WHERE r.status<>'COMPLETED'`;

export const unfinishedUserRoundsSql = `
    SELECT r.id, r.name, r.status, g.id AS "groupId", g.name AS "groupName"
    FROM round_members rm JOIN rounds r ON r.id = rm.round_id JOIN groups g ON g.id = r.group_id
    WHERE rm.user_id = $1 AND r.status <> 'COMPLETED'
    ORDER BY r.created_at, r.id
  `;

export async function getUnfinishedUserRounds(
  client: Database,
  userId: string,
): Promise<UnfinishedUserRound[]> {
  const rows = await rawRows<UnfinishedUserRound>(
    client,
    unfinishedUserRoundsSql,
    [userId],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    groupId: row.groupId,
    groupName: row.groupName,
  }));
}
