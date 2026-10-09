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
  urlencoded,
  type Request,
  type Response,
  type RequestHandler,
} from 'express';
import { AppError } from './errors';
import { objectBody } from '../util/mutations';

const BODY_LIMIT = 'api:body-limit';
const JSON_BODY = 'api:json-body';
const FORM_BODY = 'api:form-body';
export const JsonBody = () => SetMetadata(JSON_BODY, true);
export const FormBody = () => SetMetadata(FORM_BODY, true);
export const RequestBodyLimit = (bytes: number) =>
  SetMetadata(BODY_LIMIT, bytes);

@Injectable()
export class RequestBodyInterceptor implements NestInterceptor {
  private readonly parsers = new Map<string, RequestHandler>();

  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  private parser(limit: number, form: boolean) {
    const key = `${form ? 'form' : 'json'}:${limit}`;
    let parser = this.parsers.get(key);
    if (!parser) {
      const options = {
        limit,
        type: () => true,
        inflate: false,
        verify: (
          _request: Request,
          _response: Response,
          bytes: Buffer,
          encoding: string,
        ) => {
          // Preserve strict UTF-8 before either library parser maps the body.
          if (encoding.toLowerCase().replaceAll('-', '') !== 'utf8')
            throw new Error('Requests must use UTF-8');
          const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          // qs discards these names. Reject them rather than silently accepting extra fields.
          if (form) {
            const names = new URLSearchParams(text);
            if (names.has('') || names.has('__proto__'))
              throw new Error('Discarded form field');
          }
        },
      };
      parser = form
        ? urlencoded({ ...options, extended: false })
        : json({ ...options, strict: false });
      this.parsers.set(key, parser);
    }
    return parser;
  }

  async intercept(context: ExecutionContext, next: CallHandler) {
    const form = Boolean(
      this.reflector.get<boolean>(FORM_BODY, context.getHandler()),
    );
    if (form || this.reflector.get<boolean>(JSON_BODY, context.getHandler())) {
      const limit =
        this.reflector.getAllAndOverride<number>(BODY_LIMIT, [
          context.getHandler(),
          context.getClass(),
        ]) ?? 1024 * 1024;
      const http = context.switchToHttp();
      const request = http.getRequest<Request>();
      await new Promise<void>((resolve, reject) => {
        this.parser(limit, form)(
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
                    form
                      ? '올바른 로그인 요청이 필요합니다'
                      : '올바른 JSON 입력이 필요합니다',
                  ),
            );
          },
        );
      });
      request.body = request.body === undefined ? {} : request.body;
      if (!form) request.body = objectBody(request.body);
    }
    return next.handle();
  }
}
