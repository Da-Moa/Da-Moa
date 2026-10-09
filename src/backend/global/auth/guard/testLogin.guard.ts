import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { networkInterfaces } from 'node:os';
import type { Request } from 'express';
import { nodeRequestOrigin } from '../../apiPayload/http';
import { AppError } from '../../apiPayload/errors';
import { testLoginGuard } from '../../../../shared/testAccounts';

@Injectable()
export class TestLoginGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    const expected = nodeRequestOrigin(request);
    if (!expected)
      throw new AppError(403, 'forbidden', '허용되지 않은 요청입니다');
    const localAddresses = Object.values(networkInterfaces()).flatMap(
      (entries) =>
        (entries ?? [])
          .filter((entry) => entry.family === 'IPv4' && !entry.internal)
          .map((entry) => entry.address),
    );
    const denied = testLoginGuard(
      process.env.NODE_ENV,
      expected.hostname,
      request.headers.origin ?? null,
      expected.origin,
      localAddresses,
    );
    if (denied)
      throw new AppError(
        denied,
        denied === 404 ? 'not_found' : 'forbidden',
        denied === 404
          ? '요청한 API를 찾을 수 없어요'
          : '허용되지 않은 요청입니다',
      );
    if (
      !request.headers['content-type']
        ?.toLowerCase()
        .startsWith('application/x-www-form-urlencoded')
    )
      throw new AppError(
        400,
        'invalid_input',
        '올바른 로그인 요청이 필요합니다',
      );
    return true;
  }
}
