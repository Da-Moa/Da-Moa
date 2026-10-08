import { Catch, type ArgumentsHost, type ExceptionFilter, HttpException } from '@nestjs/common'
import { AppError, errorResponse } from '../errors'
import { sendResponse } from '../httpContext'

export class HttpResponseException extends Error {
  constructor(readonly response: Response) { super(`HTTP ${response.status}`) }
}

@Catch()
export class GlobalExceptionHandler implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    if (error instanceof HttpException) error = new AppError(error.getStatus(), error.getStatus() === 404 ? 'not_found' : 'invalid_input', error.message)
    return sendResponse(host.switchToHttp().getResponse(), () => error instanceof HttpResponseException ? error.response : errorResponse(error))
  }
}
