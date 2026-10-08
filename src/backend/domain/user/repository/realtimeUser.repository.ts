import {
  PrismaService,
  databaseRows,
} from '../../../global/database/prisma.service';
export async function getRealtimeUserState(userId: string) {
  const account = await new PrismaService().client.users.findUnique({
    where: { id: userId },
    select: { id: true, deleted_at: true, onboarding_completed_at: true },
  });
  return account
    ? databaseRows<{
        id: string;
        deleted_at: string | null;
        onboarding_completed_at: string | null;
      }>(account)
    : undefined;
}
