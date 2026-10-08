import { AppError, type ErrorCode } from '../../../../shared/appError'

export class HealthException extends AppError {
  constructor(error: ErrorCode, detail?: unknown) { super(error.status, error.code, error.message, detail ?? error.detail ?? undefined) }
}
