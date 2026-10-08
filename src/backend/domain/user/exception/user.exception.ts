import { AppError, type ErrorCode } from '../../../../shared/appError'
import { userErrors } from '../code/user.error.code'
import type { UnfinishedUserRound } from '../../../../shared/domain/settle'

export class UserException extends AppError {
  constructor(error: ErrorCode, detail?: unknown) { super(error.status, error.code, error.message, detail ?? error.detail ?? undefined) }
}

export const bankAccountConflict = () => new UserException(userErrors.BANK_ACCOUNT_CONFLICT)
export const alreadyOnboarded = () => new UserException(userErrors.ALREADY_ONBOARDED)
export const rejoinConfirmationRequired = () => new UserException(userErrors.REJOIN_CONFIRMATION_REQUIRED)
export const unfinishedRounds = (rounds: UnfinishedUserRound[]) => new UserException(userErrors.UNFINISHED_ROUNDS, { rounds })
