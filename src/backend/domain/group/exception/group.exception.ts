import { AppError, type ErrorCode } from '../../../../shared/appError'
import { groupErrors } from '../code/group.error.code'

export class GroupException extends AppError {
  constructor(error: ErrorCode, detail?: unknown) { super(error.status, error.code, error.message, detail ?? error.detail ?? undefined) }
}

export const missing = () => new GroupException(groupErrors.RESOURCE_NOT_FOUND)
export const duplicateGroup = () => new GroupException(groupErrors.GROUP_ALREADY_EXISTS)
export const alreadyMember = () => new GroupException(groupErrors.GROUP_ALREADY_MEMBER)
export const creatorOnly = () => new GroupException(groupErrors.CREATOR_ONLY)
export const unfinishedGroupRounds = () => new GroupException(groupErrors.UNFINISHED_GROUP_ROUNDS)
export const unfinishedRounds = () => new GroupException(groupErrors.UNFINISHED_ROUNDS)
export const memberLimitExceeded = () => new GroupException(groupErrors.MEMBER_LIMIT_EXCEEDED)
