'use client'

import { apiRequest } from '../../global/util'
import { uuidV7 } from '../../../shared/uuid'
import type { CreateGroupRequestDTO, GroupMutationResult } from '../../../shared/domain/group'

export function createGroupRequest(body: CreateGroupRequestDTO) {
  return apiRequest<GroupMutationResult>('/api/groups', { method: 'POST', body, createRequestKey: uuidV7 })
}
