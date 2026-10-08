import { HttpRequest, HttpResponse } from '../../apiPayload/httpContext';
import {
  authCookieOptions,
  createKakaoAuthorizationRequest,
  createReturnToCookie,
  createRedirectUriCookie,
  getKakaoAuthenticationConfig,
  OIDC_COOKIE_NAMES,
  OIDC_MAX_AGE_SECONDS,
  RETURN_TO_COOKIE_NAME,
  safeReturnTo,
} from '../authUtil';
import { requestOrigin } from '../../apiPayload/http';

function loginRedirect(request: HttpRequest, error: string) {
  const url = new URL('/login', requestOrigin(request) ?? request.url);
  url.searchParams.set('error', error);
  url.searchParams.set(
    'returnTo',
    safeReturnTo(request.nextUrl.searchParams.get('returnTo')),
  );
  const response = HttpResponse.redirect(url);
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}

export async function getKakaoLoginResponse(request: HttpRequest) {
  try {
    const config = getKakaoAuthenticationConfig(requestOrigin(request));
    const login = createKakaoAuthorizationRequest(config);
    const response = HttpResponse.redirect(login.url);
    const options = authCookieOptions(OIDC_MAX_AGE_SECONDS);

    response.cookies.set(OIDC_COOKIE_NAMES.state, login.state, options);
    response.cookies.set(OIDC_COOKIE_NAMES.nonce, login.nonce, options);
    response.cookies.set(
      OIDC_COOKIE_NAMES.codeVerifier,
      login.codeVerifier,
      options,
    );
    response.cookies.set(
      OIDC_COOKIE_NAMES.redirectUri,
      createRedirectUriCookie(config.redirectUri, login.state),
      options,
    );
    response.cookies.set(
      RETURN_TO_COOKIE_NAME,
      createReturnToCookie(
        request.nextUrl.searchParams.get('returnTo'),
        login.state,
      ),
      options,
    );
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch {
    return loginRedirect(request, 'configuration');
  }
}
