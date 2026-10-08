import { networkInterfaces } from 'node:os';
import { setAuthCookies } from './authCookies';
import { HttpRequest, HttpResponse } from '../../apiPayload/httpContext';
import { safeReturnTo } from '../authUtil';
import { AuthService } from '../service/auth.service';
import { AppError, errorResponse } from '../../apiPayload/errors';
import { readBytes, requestOrigin } from '../../apiPayload/http';
import { testLoginGuard } from '../../../../shared/testAccounts';

export async function getTestLoginResponse(
  request: HttpRequest,
  authService: AuthService,
) {
  try {
    const expected = requestOrigin(request);
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
      request.headers.get('origin'),
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
      !request.headers
        .get('content-type')
        ?.toLowerCase()
        .startsWith('application/x-www-form-urlencoded')
    ) {
      throw new AppError(
        400,
        'invalid_input',
        '올바른 로그인 요청이 필요합니다',
      );
    }
    let form: URLSearchParams;
    try {
      form = new URLSearchParams(
        new TextDecoder('utf-8', { fatal: true }).decode(
          await readBytes(request, 4096),
        ),
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        400,
        'invalid_input',
        '올바른 로그인 요청이 필요합니다',
      );
    }
    if (
      form.getAll('key').length !== 1 ||
      form.getAll('returnTo').length > 1 ||
      [...form.keys()].some((key) => !['key', 'returnTo'].includes(key))
    ) {
      throw new AppError(
        400,
        'invalid_input',
        '올바른 로그인 요청이 필요합니다',
      );
    }
    const session = await authService.signInTestAccount(form.get('key'));
    const response = HttpResponse.redirect(
      new URL(
        `/auth/complete?returnTo=${encodeURIComponent(safeReturnTo(form.get('returnTo')))}`,
        expected,
      ),
      303,
    );
    setAuthCookies(response, session);
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
