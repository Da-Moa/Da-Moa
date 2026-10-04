import 'server-only'
import type { Database } from '../../../../Global/Util/Backend'
import type { ActiveUserProfile } from '../../Shared'

export async function findActiveUserProfiles(client: Database, userIds: string[]): Promise<ActiveUserProfile[]> {
  const { rows } = await client.query(`SELECT id AS "userId",COALESCE(display_name,'카카오 사용자') AS "displayName",profile_image_url AS "profileImageUrl"
    FROM users WHERE id=ANY($1::text[]) AND deleted_at IS NULL AND onboarding_completed_at IS NOT NULL ORDER BY id`, [userIds])
  return rows.map(row => ({ userId: row.userId, displayName: row.displayName, profileImageUrl: row.profileImageUrl }))
}
