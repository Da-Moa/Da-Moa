import cookieParser from 'cookie-parser';
import type { Request as ExpressRequest, Response } from 'express';
import { nativeJwtGuard } from '../../global/auth/guard/jwt.guard';
import type { AccessToken } from '../../global/auth/authUtil';

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
  return nativeJwtGuard(native, authenticated);
}
