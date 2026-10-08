import {
  Injectable,
  Inject,
  SetMetadata,
  type NestInterceptor,
  type ExecutionContext,
  type CallHandler,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, map } from 'rxjs';
import { ApiResponseDto, type ApiSuccessCode } from './response.dto';
import { responseScope } from './httpContext';

export const API_SUCCESS = 'api:success';
export const RawApiResponse = () => SetMetadata(API_SUCCESS, null);
export const ApiSuccess = (meta: ApiSuccessCode) =>
  SetMetadata(API_SUCCESS, meta);

@Injectable()
export class ApiResponseInterceptor implements NestInterceptor {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}
  async intercept(context: ExecutionContext, next: CallHandler) {
    const meta = this.reflector.getAllAndOverride<ApiSuccessCode>(API_SUCCESS, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!meta) return next.handle();
    const response = context.switchToHttp().getResponse();
    response.setHeader('Cache-Control', 'private, no-store');
    return new Observable((subscriber) =>
      responseScope(response, () =>
        next
          .handle()
          .pipe(map((data) => new ApiResponseDto(meta, data)))
          .subscribe(subscriber),
      ),
    );
  }
}
