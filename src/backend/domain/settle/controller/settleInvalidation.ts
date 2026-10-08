import {
  publishInvalidations,
  type ResourceKey,
} from '../../../global/websocket';

export type RoundAudience = {
  groupId: string;
  userIds: string[];
  groupUserIds?: string[];
};

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
  const publications: { userIds: string[]; keys: ResourceKey[] }[] = [
    { userIds: audience.userIds, keys },
  ];
  return publishInvalidations(publications);
}
