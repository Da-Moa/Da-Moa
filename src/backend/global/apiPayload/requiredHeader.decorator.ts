import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { ErrorCode } from '../../../shared/appError';
import { AppError } from './errors';

const idempotencyKeyError: ErrorCode = {
  status: 400,
  code: 'invalid_request_key',
  message: '올바른 요청 키가 필요합니다',
  detail: null,
};

function readHeader(request: Request, name: string, error: ErrorCode): string {
  const value = request.headers[name];
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new AppError(
      error.status,
      error.code,
      error.message,
      error.detail ?? undefined,
    );
  return value;
}

export function readIdempotencyKey(request: Request) {
  return readHeader(request, 'idempotency-key', idempotencyKeyError);
}

type RequiredHeaderOptions = { name: string; error: ErrorCode };

const readRequiredHeader = createParamDecorator(
  (
    { name, error }: RequiredHeaderOptions,
    context: ExecutionContext,
  ): string => {
    return readHeader(
      context.switchToHttp().getRequest<Request>(),
      name,
      error,
    );
  },
);

export function RequiredHeader(
  name: string,
  error: ErrorCode = {
    status: 400,
    code: 'invalid_input',
    message: `${name} 헤더가 필요합니다`,
    detail: null,
  },
): ParameterDecorator {
  return readRequiredHeader({ name: name.toLowerCase(), error });
}

export function RequiredIdempotencyKey(
  error: ErrorCode = idempotencyKeyError,
): ParameterDecorator {
  return RequiredHeader('idempotency-key', error);
}
