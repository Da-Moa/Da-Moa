import { HttpException, UnauthorizedException } from '@nestjs/common'
import type { Response } from 'express'
import { channel } from 'node:diagnostics_channel'
import { AppError } from '../../../shared/appError'
export { AppError } from '../../../shared/appError'

export function badInput(
  code = 'invalid_input',
  message = '입력값을 확인해 주세요',
): never {
  throw new AppError(400, code, message)
}

export function errorPayload(error: unknown) {
  // Refresh endpoints intentionally retain their short unauthorized payload.
  if (error instanceof UnauthorizedException) {
    return { status: error.getStatus(), body: error.getResponse() }
  }
  if (error instanceof HttpException) {
    error = new AppError(
      error.getStatus(),
      error.getStatus() === 404 ? 'not_found' : 'invalid_input',
      error.message,
    )
  }
  if (
    !(error instanceof AppError) &&
    error &&
    typeof error === 'object' &&
    'code' in error &&
    ['22003', '22001'].includes(String(error.code))
  ) {
    error = new AppError(
      400,
      'storage_value_limit',
      '저장소가 처리할 수 있는 입력 크기를 넘었어요. 값을 확인해 주세요',
    )
  }
  const known = error instanceof AppError ? error : null
  if (!known) {
    channel('da-moa.api.exception').publish({})
    console.error('Unhandled server error', error)
  }
  return {
    status: known ? known.status : 503,
    body: {
      error: known ? known.code : 'storage_unavailable',
      code: known ? known.code : 'storage_unavailable',
      detail: known?.details ?? null,
      message: known
        ? known.message
        : '저장소에 연결하지 못했어요. 같은 요청으로 다시 시도해 주세요',
      ...(known && known.details !== undefined
        ? { details: known.details }
        : {}),
    },
  }
}

export function writeErrorResponse(response: Response, error: unknown) {
  const { status, body } = errorPayload(error)
  response.setHeader('Cache-Control', 'private, no-store')
  return response.status(status).json(body)
}
