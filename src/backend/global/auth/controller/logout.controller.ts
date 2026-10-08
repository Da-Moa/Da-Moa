import { clearAuthCookies } from './authCookies';
import { HttpRequest, HttpResponse } from '../../apiPayload/httpContext';
import { sameOrigin } from '../../apiPayload/http';

export async function getLogoutResponse(request: HttpRequest) {
  if (!sameOrigin(request)) {
    const response = HttpResponse.json({ error: 'forbidden' }, { status: 403 });
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  }

  const response = HttpResponse.json({ ok: true });
  clearAuthCookies(response, { returnTo: true });
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}
