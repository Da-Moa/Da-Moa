export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message)
    this.name = 'AppError'
  }
}

export function badInput(code = 'invalid_input', message = '입력값을 확인해 주세요'): never {
  throw new AppError(400, code, message)
}

export function errorResponse(error: unknown): Response {
  if (!(error instanceof AppError) && error && typeof error === 'object' && 'code' in error && ['22003', '22001'].includes(String(error.code))) {
    error = new AppError(400, 'storage_value_limit', '저장소가 처리할 수 있는 입력 크기를 넘었어요. 값을 확인해 주세요')
  }
  const known = error instanceof AppError ? error : null
  if (!known) console.error('Unhandled server error', error)
  return Response.json({
    error: known ? known.code : 'storage_unavailable',
    message: known ? known.message : '저장소에 연결하지 못했어요. 같은 요청으로 다시 시도해 주세요',
    ...(known && known.details !== undefined ? { details: known.details } : {}),
  }, { status: known ? known.status : 503, headers: { 'Cache-Control': 'private, no-store' } })
}
