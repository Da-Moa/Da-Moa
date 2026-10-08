import type { ResourceKey } from '../../../shared/global/websocket/realtime';

type Publication = { userIds: string[]; keys: ResourceKey[] };
export type RoundAudience = {
  groupId: string;
  userIds: string[];
  groupUserIds?: string[];
};

export function realtimeEnabled() {
  return Boolean(
    process.env.REALTIME_INTERNAL_SECRET && process.env.REALTIME_INTERNAL_PORT,
  );
}

export async function publishInvalidations(publications: Publication[]) {
  if (!realtimeEnabled()) return;
  try {
    const byUser = new Map<string, Set<ResourceKey>>();
    for (const { userIds, keys } of publications)
      for (const userId of userIds) {
        const current = byUser.get(userId) ?? new Set<ResourceKey>();
        keys.forEach((key) => current.add(key));
        byUser.set(userId, current);
      }
    if (!byUser.size) return;
    const response = await fetch(
      `http://127.0.0.1:${process.env.REALTIME_INTERNAL_PORT}/internal/realtime`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${process.env.REALTIME_INTERNAL_SECRET}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(
          [...byUser].map(([userId, keys]) => ({ userId, keys: [...keys] })),
        ),
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!response.ok) throw new Error('Realtime invalidation failed');
  } catch {
    console.error('Realtime invalidation failed');
  }
}

export function publishGroupInvalidation(
  groupId: string,
  userIds: string[] = [],
  detailOnly = false,
) {
  const keys: ResourceKey[] = detailOnly
    ? [`group:${groupId}`]
    : ['groups', `group:${groupId}`];
  return publishInvalidations([{ userIds, keys }]);
}

export function publishRoundInvalidation(
  roundId: string,
  audience: RoundAudience | null,
  settlementOnly = false,
) {
  if (!audience) return Promise.resolve();
  const keys: ResourceKey[] = settlementOnly
    ? [`settlement:${roundId}`]
    : [
        'rounds',
        `group-rounds:${audience.groupId}`,
        `round:${roundId}`,
        `settlement:${roundId}`,
      ];
  return publishInvalidations([{ userIds: audience.userIds, keys }]);
}

export async function publishBankInvalidation(
  userId: string,
  getRecipients: (
    userId: string,
  ) => Promise<{ sender_id: string; round_id: string }[]>,
) {
  if (!realtimeEnabled()) return;
  // Refresh the owner's account even if the separate recipient lookup fails.
  await publishInvalidations([{ userIds: [userId], keys: ['me'] }]);
  try {
    const recipients = await getRecipients(userId);
    await publishInvalidations(
      recipients.map((row) => ({
        userIds: [row.sender_id],
        keys: [`settlement:${row.round_id}`],
      })),
    );
  } catch {
    console.error('Realtime bank invalidation failed');
  }
}

export async function publishDepartureInvalidation(
  groupIds: string[],
  getMembers: (
    groupIds: string[],
  ) => Promise<{ group_id: string; user_id: string }[]>,
) {
  if (!realtimeEnabled() || !groupIds.length) return;
  try {
    const members = await getMembers(groupIds);
    await publishInvalidations(
      groupIds.map((groupId) => ({
        userIds: members
          .filter((row) => row.group_id === groupId)
          .map((row) => row.user_id),
        keys: ['groups', `group:${groupId}`],
      })),
    );
  } catch {
    console.error('Realtime departure invalidation failed');
  }
}
