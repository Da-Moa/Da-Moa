import {
  Injectable,
  SetMetadata,
  type NestInterceptor,
  type ExecutionContext,
  type CallHandler,
} from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants.js';
import { readJsonBody } from './http';
import { webRequest } from './httpContext';

const BODY_LIMIT = 'api:body-limit';
export const RequestBodyLimit = (bytes: number) =>
  SetMetadata(BODY_LIMIT, bytes);

@Injectable()
export class RequestBodyInterceptor implements NestInterceptor {
  async intercept(context: ExecutionContext, next: CallHandler) {
    const args =
      Reflect.getMetadata(
        ROUTE_ARGS_METADATA,
        context.getClass(),
        context.getHandler().name,
      ) ?? {};
    const body = Object.entries(args).find(([key]) =>
      key.startsWith('3:'),
    )?.[1] as { pipes: unknown[] } | undefined;
    if (body) {
      const limit =
        Reflect.getMetadata(BODY_LIMIT, context.getHandler()) ??
        Reflect.getMetadata(BODY_LIMIT, context.getClass()) ??
        1024 * 1024;
      const request = context.switchToHttp().getRequest();
      request.body = await readJsonBody(webRequest(request), limit);
    }
    return next.handle();
  }
}
