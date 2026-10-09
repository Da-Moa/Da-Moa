import { captureResponse } from './nativeResponseTestSupport';
import { writeErrorResponse } from '../../global/apiPayload/errors';
import type { ExecutionContext } from '@nestjs/common';
import type { AuthenticatedRequest } from '../../global/auth/decorator/currentUser.decorator';
import { JwtService } from '@nestjs/jwt';
import { TokenService } from '../../global/auth/service/token.service';
import { getSessionSecret } from '../../global/auth/authConfig';
import cookieParser from 'cookie-parser';
import type { Request as ExpressRequest, Response } from 'express';
import { JwtGuard } from '../../global/auth/guard/jwt.guard';
import type { AccessToken } from '../../global/auth/authUtil';

export const testTokens = new TokenService(
  new JwtService({ secretOrKeyProvider: getSessionSecret }),
);

// Pure policy fixtures use the same cookie middleware and native Guard as HTTP.
export function jwtGuardForTest(
  request: Request,
  authenticated?: (user: AccessToken) => void,
) {
  const url = new URL(request.url);
  const native = {
    method: request.method,
    originalUrl: url.pathname + url.search,
    protocol: url.protocol.slice(0, -1),
    headers: { host: url.host, ...Object.fromEntries(request.headers) },
  } as ExpressRequest;
  cookieParser()(native, {} as Response, () => {});
  const captured = captureResponse(native);
  try {
    new JwtGuard(testTokens).canActivate({
      switchToHttp: () => ({
        getRequest: () => native,
        getResponse: () => captured.response,
      }),
    } as unknown as ExecutionContext);
    const user = (native as AuthenticatedRequest).user;
    if (user) authenticated?.(user);
    return null;
  } catch (error) {
    writeErrorResponse(captured.response, error);
    return captured.result!;
  }
}
