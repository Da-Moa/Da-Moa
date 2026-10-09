import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

// Parsing belongs to cookie-parser middleware, which runs before Guards.
export const Cookies = createParamDecorator(
  (name: string | undefined, context: ExecutionContext): unknown => {
    const cookies = context.switchToHttp().getRequest<Request>().cookies;
    if (name === undefined) return cookies;
    const value: unknown = cookies?.[name];
    // Authentication cookies contain strings, not cookie-parser JSON objects.
    return typeof value === 'string' ? value : undefined;
  },
);
