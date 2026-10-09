export type ErrorCode = { status: number; code: string; message: string; detail: unknown }

export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message)
    this.name = 'AppError'
  }
}
