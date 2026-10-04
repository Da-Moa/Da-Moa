'use client'

import { apiRequest } from '../../../Global/Util/Frontend'
import { uuidV7 } from '../../../lib/uuid'
import type { CreateRoundRequestDTO, MutationResult } from '../Shared'

export function createRoundRequest(groupId: string, body: CreateRoundRequestDTO) {
  return apiRequest<MutationResult>(`/api/groups/${groupId}/rounds`, { method: 'POST', body, createRequestKey: uuidV7 })
}
