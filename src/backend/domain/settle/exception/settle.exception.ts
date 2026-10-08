import { AppError, type ErrorCode } from '../../../../shared/appError'
import { settleErrors } from '../code/settle.error.code'

export class SettleException extends AppError {
  constructor(error: ErrorCode, detail?: unknown) { super(error.status, error.code, error.message, detail ?? error.detail ?? undefined) }
}

export const missing = () => new SettleException(settleErrors.RESOURCE_NOT_FOUND)

export const duplicateRound = () => new SettleException(settleErrors.ROUND_ALREADY_EXISTS)
