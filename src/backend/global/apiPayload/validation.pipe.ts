import { ValidationPipe } from '@nestjs/common';
import type { ValidationError } from 'class-validator';
import { AppError } from './errors';

function firstFailure(
  errors: ValidationError[],
  parent = '',
): { field: string; code: string; message: string } {
  for (const error of errors) {
    const field = parent ? `${parent}.${error.property}` : error.property;
    if (error.constraints) {
      const context = Object.values(error.contexts ?? {})[0] as
        { code?: string; message?: string } | undefined;
      return {
        field,
        code: context?.code ?? 'invalid_input',
        message: context?.message ?? '입력값을 확인해 주세요',
      };
    }
    if (error.children?.length) return firstFailure(error.children, field);
  }
  return {
    field: parent,
    code: 'invalid_input',
    message: '입력값을 확인해 주세요',
  };
}

export function createValidationPipe() {
  return new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    transformOptions: {
      enableImplicitConversion: false,
      exposeDefaultValues: true,
    },
    validationError: { target: false, value: false },
    exceptionFactory: (errors) => {
      const { field, code, message } = firstFailure(errors);
      return new AppError(400, code, message, { field });
    },
  });
}
