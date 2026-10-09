import {
  Injectable,
  Inject,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { HttpResponseException } from '../../apiPayload/handler/global.exception.handler';
import { clearAuthCookies } from '../controller/authCookies';
import { HttpResponse } from '../../apiPayload/httpContext';
import { REFRESH_TOKEN_COOKIE_NAME } from '../authUtil';
import { TokenService } from '../service/token.service';
import { apiJwtPolicy, readApiJwt } from '../apiJwtUtil';
import { AppError, errorResponse } from '../../apiPayload/errors';
import type { AccessToken } from '../authUtil';
import type { AuthenticatedRequest } from '../decorator/currentUser.decorator';
import type { Request as ExpressRequest } from 'express';

function authorizeApiRequest(
  tokens: TokenService,
  method: string,
  pathname: string,
  authorization: string | null,
  refreshCookie: string | undefined,
  authenticated?: (user: AccessToken) => void,
): Response | null {
  const policy = apiJwtPolicy(method, pathname);
  if (policy === 'public') return null;
  const user = readApiJwt(
    tokens,
    method,
    pathname,
    authorization,
    refreshCookie,
  );
  if (user) {
    authenticated?.(user);
    return null;
  }

  if (policy === 'refresh') {
    const response = HttpResponse.json(
      { error: 'unauthorized' },
      { status: 401, headers: { 'Cache-Control': 'private, no-store' } },
    );
    clearAuthCookies(response);
    return response;
  }
  return errorResponse(
    new AppError(401, 'unauthorized', '로그인이 필요합니다'),
  );
}

@Injectable()
export class JwtGuard implements CanActivate {
  constructor(@Inject(TokenService) private readonly tokens: TokenService) {}
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    delete request.user;
    const denied = nativeJwtGuard(request, this.tokens, (user) => {
      request.user = user;
    });
    if (denied) throw new HttpResponseException(denied);
    return true;
  }
}

export function nativeJwtGuard(
  request: ExpressRequest,
  tokens: TokenService,
  authenticated?: (user: AccessToken) => void,
): Response | null {
  const pathname = new URL(request.originalUrl, 'http://localhost').pathname;
  const policy = apiJwtPolicy(request.method, pathname);
  const refreshCookie: unknown =
    policy === 'refresh' || policy === 'logout'
      ? request.cookies?.[REFRESH_TOKEN_COOKIE_NAME]
      : undefined;
  return authorizeApiRequest(
    tokens,
    request.method,
    pathname,
    request.headers.authorization ?? null,
    typeof refreshCookie === 'string' ? refreshCookie : undefined,
    authenticated,
  );
}
