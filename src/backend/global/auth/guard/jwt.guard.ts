import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { webRequest } from '../../apiPayload/httpContext';
import { HttpResponseException } from '../../apiPayload/handler/global.exception.handler';
import { clearAuthCookies } from '../controller/authCookies';
import { HttpResponse, type HttpRequest } from '../../apiPayload/httpContext';
import { REFRESH_TOKEN_COOKIE_NAME } from '../authUtil';
import { apiJwtPolicy, readApiJwt } from '../apiJwtUtil';
import { AppError, errorResponse } from '../../apiPayload/errors';
import type { AccessToken } from '../authUtil';
import type { AuthenticatedRequest } from '../decorator/currentUser.decorator';

export function jwtGuard(
  request: HttpRequest,
  authenticated?: (user: AccessToken) => void,
): Response | null {
  const { pathname } = request.nextUrl;
  const method = request.method;
  const policy = apiJwtPolicy(method, pathname);
  if (policy === 'public') return null;
  const user = readApiJwt(
    method,
    pathname,
    request.headers.get('authorization'),
    request.cookies.get(REFRESH_TOKEN_COOKIE_NAME)?.value,
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
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    delete request.user;
    const denied = jwtGuard(webRequest(request), (user) => {
      request.user = user;
    });
    if (denied) throw new HttpResponseException(denied);
    return true;
  }
}
