import type { RoundStatus } from '../../../lib/domain-types'

export type UnfinishedUserRound = { id: string; name: string; status: RoundStatus; groupId: string; groupName: string }
