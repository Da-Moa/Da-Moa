'use client'

import { apiRequest } from '../../global/util'
import { uuidV7 } from '../../../shared/uuid'
import type { CreateRoundRequestDTO, MutationResult } from '../../../shared/domain/settle'

export function createRoundRequest(groupId: string, body: CreateRoundRequestDTO) {
  return apiRequest<MutationResult>(`/api/groups/${groupId}/rounds`, { method: 'POST', body, createRequestKey: uuidV7 })
}
