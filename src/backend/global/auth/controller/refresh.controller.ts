import { clearAuthCookies, setAuthCookies } from './authCookies';
import { AuthService } from '../service/auth.service';
import { HttpRequest, HttpResponse } from '../../apiPayload/httpContext';
import { readRefreshToken, REFRESH_TOKEN_COOKIE_NAME } from '../authUtil';
import { sameOrigin } from '../../apiPayload/http';

function unauthorizedResponse() {
  const response = HttpResponse.json(
    { error: 'unauthorized' },
    { status: 401 },
  );
  clearAuthCookies(response);
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}

function unavailableResponse() {
  const response = HttpResponse.json(
    { error: 'refresh_unavailable' },
    { status: 503 },
  );
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}

export async function getRefreshResponse(
  request: HttpRequest,
  authService: AuthService,
) {
  if (!sameOrigin(request)) {
    return HttpResponse.json(
      { error: 'forbidden', message: '허용되지 않은 요청입니다' },
      {
        status: 403,
        headers: { 'Cache-Control': 'private, no-store' },
      },
    );
  }

  const token = request.cookies.get(REFRESH_TOKEN_COOKIE_NAME)?.value;
  const refresh = readRefreshToken(token);
  if (!token || !refresh) return unauthorizedResponse();

  try {
    const session = authService.refreshTokens(refresh);
    const response = HttpResponse.json({
      data: { accessToken: session.accessToken },
    });
    setAuthCookies(response, session);
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch {
    return unavailableResponse();
  }
}
