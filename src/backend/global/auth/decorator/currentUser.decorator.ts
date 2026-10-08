import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AccessToken } from '../authUtil';
import { AppError } from '../../apiPayload/errors';

// Claims verified by JwtGuard; this is not the serialized JWT string.
export type AuthenticatedUser = AccessToken;
export type AuthenticatedRequest = Request & { user?: AuthenticatedUser };

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
    if (!user) throw new AppError(401, 'unauthorized', '로그인이 필요합니다');
    return user;
  },
);
