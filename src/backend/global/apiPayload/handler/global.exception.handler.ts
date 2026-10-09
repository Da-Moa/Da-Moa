import {
  Catch,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import { writeErrorResponse } from '../errors';

@Catch()
export class GlobalExceptionHandler implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    return writeErrorResponse(
      host.switchToHttp().getResponse<Response>(),
      error,
    );
  }
}
