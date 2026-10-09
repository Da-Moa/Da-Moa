import {
  Injectable,
  Inject,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { clearAuthCookies } from '../controller/authCookies';
import { REFRESH_TOKEN_COOKIE_NAME } from '../authUtil';
import { TokenService } from '../service/token.service';
import { apiJwtPolicy, readApiJwt } from '../apiJwtUtil';
import { AppError } from '../../apiPayload/errors';
import type { AccessToken } from '../authUtil';
import type { AuthenticatedRequest } from '../decorator/currentUser.decorator';
import type { Request, Response } from 'express';

// Nest and the Swagger UI middleware share the same request authentication policy.
export function authenticateApiRequest(
  request: Request,
  tokens: TokenService,
): AccessToken | null {
  const pathname = new URL(request.originalUrl, 'http://localhost').pathname;
  const policy = apiJwtPolicy(request.method, pathname);
  if (policy === 'public') return null;
  const cookie: unknown =
    policy === 'refresh' || policy === 'logout'
      ? request.cookies?.[REFRESH_TOKEN_COOKIE_NAME]
      : undefined;
  const user = readApiJwt(
    tokens,
    request.method,
    pathname,
    request.headers.authorization ?? null,
    typeof cookie === 'string' ? cookie : undefined,
  );
  if (user) return user;
  if (policy === 'refresh')
    throw new UnauthorizedException({ error: 'unauthorized' });
  throw new AppError(401, 'unauthorized', '로그인이 필요합니다');
}

@Injectable()
export class JwtGuard implements CanActivate {
  constructor(@Inject(TokenService) private readonly tokens: TokenService) {}
  canActivate(context: ExecutionContext) {
    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    delete request.user;
    try {
      const user = authenticateApiRequest(request, this.tokens);
      if (user) request.user = user;
      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException)
        clearAuthCookies(http.getResponse<Response>());
      throw error;
    }
  }
}
