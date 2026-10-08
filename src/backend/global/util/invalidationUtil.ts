import { Injectable } from '@nestjs/common';
import type { ResourceKey } from '../../../shared/global/websocket/realtime';

type Publication = { userIds: string[]; keys: ResourceKey[] };
type InvalidationPublisher = (userId: string, keys: ResourceKey[]) => void;

export type RoundAudience = {
  groupId: string;
  userIds: string[];
  groupUserIds?: string[];
};

@Injectable()
export class RealtimePublisher {
  private publisher?: { publish: InvalidationPublisher };
  registerInvalidationPublisher(publish: InvalidationPublisher) {
    const registration = { publish };
    this.publisher = registration;
    return () => {
      if (this.publisher === registration) this.publisher = undefined;
    };
  }

  realtimeEnabled() {
    return this.publisher !== undefined;
  }

  async publishInvalidations(publications: Publication[]) {
    const currentPublisher = this.publisher;
    if (!currentPublisher) return;
    try {
      const byUser = new Map<string, Set<ResourceKey>>();
      for (const { userIds, keys } of publications)
        for (const userId of userIds) {
          const current = byUser.get(userId) ?? new Set<ResourceKey>();
          keys.forEach((key) => current.add(key));
          byUser.set(userId, current);
        }
      for (const [userId, keys] of byUser)
        currentPublisher.publish(userId, [...keys]);
    } catch {
      console.error('Realtime invalidation failed');
    }
  }

  publishGroupInvalidation(
    groupId: string,
    userIds: string[] = [],
    detailOnly = false,
  ) {
    const keys: ResourceKey[] = detailOnly
      ? [`group:${groupId}`]
      : ['groups', `group:${groupId}`];
    return this.publishInvalidations([{ userIds, keys }]);
  }

  publishRoundInvalidation(
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
    return this.publishInvalidations([{ userIds: audience.userIds, keys }]);
  }

  async publishBankInvalidation(
    userId: string,
    getRecipients: (
      userId: string,
    ) => Promise<{ sender_id: string; round_id: string }[]>,
  ) {
    if (!this.realtimeEnabled()) return;
    // Refresh the owner's account even if the separate recipient lookup fails.
    await this.publishInvalidations([{ userIds: [userId], keys: ['me'] }]);
    try {
      const recipients = await getRecipients(userId);
      await this.publishInvalidations(
        recipients.map((row) => ({
          userIds: [row.sender_id],
          keys: [`settlement:${row.round_id}`],
        })),
      );
    } catch {
      console.error('Realtime bank invalidation failed');
    }
  }

  async publishDepartureInvalidation(
    groupIds: string[],
    getMembers: (
      groupIds: string[],
    ) => Promise<{ group_id: string; user_id: string }[]>,
  ) {
    if (!this.realtimeEnabled() || !groupIds.length) return;
    try {
      const members = await getMembers(groupIds);
      await this.publishInvalidations(
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
}
