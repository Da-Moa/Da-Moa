import type { Database } from '../../../global/util';
import type { ActiveUserProfile } from '../../../../shared/domain/user';
export async function findActiveUserProfiles(
  client: Database,
  userIds: string[],
): Promise<ActiveUserProfile[]> {
  const rows = await client.prisma.users.findMany({
    where: {
      id: { in: userIds },
      deleted_at: null,
      onboarding_completed_at: { not: null },
    },
    select: { id: true, display_name: true, profile_image_url: true },
    orderBy: { id: 'asc' },
  });
  return rows.map((row) => ({
    userId: row.id,
    displayName: row.display_name ?? '카카오 사용자',
    profileImageUrl: row.profile_image_url,
  }));
}
