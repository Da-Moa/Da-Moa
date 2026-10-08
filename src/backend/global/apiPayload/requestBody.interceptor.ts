import {
  Injectable,
  Inject,
  SetMetadata,
  type NestInterceptor,
  type ExecutionContext,
  type CallHandler,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  json,
  type Request,
  type Response,
  type RequestHandler,
} from 'express';
import { AppError } from './errors';
import { objectBody } from '../util/mutations';

const BODY_LIMIT = 'api:body-limit';
const JSON_BODY = 'api:json-body';
export const JsonBody = () => SetMetadata(JSON_BODY, true);
export const RequestBodyLimit = (bytes: number) =>
  SetMetadata(BODY_LIMIT, bytes);

@Injectable()
export class RequestBodyInterceptor implements NestInterceptor {
  private readonly parsers = new Map<number, RequestHandler>();

  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  private parser(limit: number) {
    let parser = this.parsers.get(limit);
    if (!parser) {
      parser = json({
        limit,
        type: () => true,
        strict: false,
        inflate: false,
        verify: (_request, _response, bytes, encoding) => {
          // Preserve the API's strict UTF-8 contract before the library parses JSON.
          if (encoding.toLowerCase().replaceAll('-', '') !== 'utf8')
            throw new Error('JSON requests must use UTF-8');
          new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        },
      });
      this.parsers.set(limit, parser);
    }
    return parser;
  }

  async intercept(context: ExecutionContext, next: CallHandler) {
    if (this.reflector.get<boolean>(JSON_BODY, context.getHandler())) {
      const limit =
        this.reflector.getAllAndOverride<number>(BODY_LIMIT, [
          context.getHandler(),
          context.getClass(),
        ]) ?? 1024 * 1024;
      const http = context.switchToHttp();
      const request = http.getRequest<Request>();
      await new Promise<void>((resolve, reject) => {
        this.parser(limit)(
          request,
          http.getResponse<Response>(),
          (error?: unknown) => {
            if (!error) return resolve();
            reject(
              typeof error === 'object' &&
                'type' in error &&
                error.type === 'entity.too.large'
                ? new AppError(
                    413,
                    'request_too_large',
                    '요청 크기가 너무 커요',
                  )
                : new AppError(
                    400,
                    'invalid_input',
                    '올바른 JSON 입력이 필요합니다',
                  ),
            );
          },
        );
      });
      request.body = objectBody(request.body === undefined ? {} : request.body);
    }
    return next.handle();
  }
}
