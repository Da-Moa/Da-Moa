'use client'

import { apiRequest } from '../../../Global/Util/Frontend'
import { uuidV7 } from '../../../lib/uuid'
import type { CreateGroupRequestDTO, GroupMutationResult } from '../Shared'

export function createGroupRequest(body: CreateGroupRequestDTO) {
  return apiRequest<GroupMutationResult>('/api/groups', { method: 'POST', body, createRequestKey: uuidV7 })
}
