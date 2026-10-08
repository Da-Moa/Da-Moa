import {
  Injectable,
  Inject,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { API_SUCCESS } from './apiResponse.interceptor';
import { sameOrigin } from './http';
import { webRequest } from './httpContext';
import { AppError } from './errors';

@Injectable()
export class OriginGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    const ordinaryApi = this.reflector.getAllAndOverride(API_SUCCESS, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (
      ordinaryApi &&
      !['GET', 'HEAD'].includes(request.method) &&
      !sameOrigin(webRequest(request))
    ) {
      throw new AppError(403, 'forbidden', '허용되지 않은 요청입니다');
    }
    return true;
  }
}
