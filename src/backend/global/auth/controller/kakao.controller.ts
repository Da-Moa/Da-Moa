import { Controller, Get, Inject, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { nodeRequestOrigin } from '../../apiPayload/http';
import { Cookies } from '../decorator/cookies.decorator';
import { KakaoAuthService } from '../service/kakaoAuth.service';
import {
  authCookieOptions,
  createKakaoAuthorizationRequest,
  createRedirectUriCookie,
  createReturnToCookie,
  getKakaoAuthenticationConfig,
  ONBOARDING_MAX_AGE_SECONDS,
  OIDC_COOKIE_NAMES,
  OIDC_MAX_AGE_SECONDS,
  RETURN_TO_COOKIE_NAME,
  safeReturnTo,
} from '../authUtil';
import { clearOidcCookies, setAuthCookies } from './authCookies';

// Keep the first-value query contract when a browser repeats a query key.
function queryString(value: unknown): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first : null;
}

function requestBase(request: Request) {
  return (
    nodeRequestOrigin(request) ??
    new URL(
      request.originalUrl,
      `${request.protocol}://${request.headers.host || 'localhost'}`,
    )
  );
}

@Controller()
export class KakaoController {
  constructor(
    @Inject(KakaoAuthService) private readonly service: KakaoAuthService,
  ) {}

  @Get('api/auth/kakao')
  login(
    @Req() request: Request,
    @Query('returnTo') returnTo: unknown,
    @Res() response: Response,
  ) {
    response.setHeader('Cache-Control', 'private, no-store');
    try {
      const config = getKakaoAuthenticationConfig(nodeRequestOrigin(request));
      const login = createKakaoAuthorizationRequest(config);
      const options = authCookieOptions(OIDC_MAX_AGE_SECONDS);
      // Compute signatures before writing any cookie so failed configuration writes none.
      const redirectCookie = createRedirectUriCookie(
        config.redirectUri,
        login.state,
      );
      const returnCookie = createReturnToCookie(
        queryString(returnTo),
        login.state,
      );
      response.cookie(OIDC_COOKIE_NAMES.state, login.state, options);
      response.cookie(OIDC_COOKIE_NAMES.nonce, login.nonce, options);
      response.cookie(
        OIDC_COOKIE_NAMES.codeVerifier,
        login.codeVerifier,
        options,
      );
      response.cookie(OIDC_COOKIE_NAMES.redirectUri, redirectCookie, options);
      response.cookie(RETURN_TO_COOKIE_NAME, returnCookie, options);
      response.redirect(307, login.url);
    } catch {
      const destination = new URL('/login', requestBase(request));
      destination.search = new URLSearchParams({
        error: 'configuration',
        returnTo: safeReturnTo(queryString(returnTo)),
      }).toString();
      response.redirect(307, destination.toString());
    }
  }

  @Get('auth/v1/kakao')
  async callback(
    @Req() request: Request,
    @Res() response: Response,
    @Query('code') code: unknown,
    @Query('state') state: unknown,
    @Query('error') error: unknown,
    @Cookies(OIDC_COOKIE_NAMES.state) expectedState?: string,
    @Cookies(OIDC_COOKIE_NAMES.nonce) nonce?: string,
    @Cookies(OIDC_COOKIE_NAMES.codeVerifier) codeVerifier?: string,
    @Cookies(OIDC_COOKIE_NAMES.redirectUri) redirectUri?: string,
    @Cookies(RETURN_TO_COOKIE_NAME) returnCookie?: string,
  ) {
    const result = await this.service.complete(
      nodeRequestOrigin(request),
      {
        code: queryString(code),
        state: queryString(state),
        error: queryString(error),
      },
      {
        state: expectedState,
        nonce,
        codeVerifier,
        redirectUri,
        returnTo: returnCookie,
      },
    );
    response.setHeader('Cache-Control', 'private, no-store');
    let destination: URL;
    if ('error' in result) {
      destination = new URL('/login', requestBase(request));
      destination.search = new URLSearchParams({
        error: result.error,
        returnTo: result.returnTo,
      }).toString();
    } else {
      const { session, returnTo } = result;
      setAuthCookies(response, session);
      response.cookie(
        RETURN_TO_COOKIE_NAME,
        session.purpose === 'onboarding'
          ? createReturnToCookie(returnTo, queryString(state)!)
          : '',
        authCookieOptions(
          session.purpose === 'onboarding' ? ONBOARDING_MAX_AGE_SECONDS : 0,
        ),
      );
      destination = new URL(
        `/auth/complete?returnTo=${encodeURIComponent(returnTo)}`,
        requestBase(request),
      );
    }
    clearOidcCookies(response);
    response.redirect(307, destination.toString());
  }
}
