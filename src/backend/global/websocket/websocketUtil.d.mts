import type { ResourceKey } from '../../../shared/global/websocket/realtime'

export function publishInvalidations(publications: { userIds: string[]; keys: ResourceKey[] }[]): Promise<void>
