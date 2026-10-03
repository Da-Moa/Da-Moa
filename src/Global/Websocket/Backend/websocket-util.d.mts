import type { ResourceKey } from '../Shared/realtime'

export function publishInvalidations(publications: { userIds: string[]; keys: ResourceKey[] }[]): Promise<void>
