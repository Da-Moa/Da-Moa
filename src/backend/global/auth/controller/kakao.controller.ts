import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiErrors } from '../../apiPayload/documentation.decorator';
import { Controller, Get, Inject, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { nodeRequestOrigin } from '../../apiPayload/http';
import { Cookies } from '../decorator/cookies.decorator';
import { KakaoAuthService } from '../service/kakaoAuth.service';
import { KakaoOidcClient } from '../service/kakaoOidc.client';
import {
  authCookieOptions,
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

@ApiTags('인증')
@Controller()
export class KakaoController {
  constructor(
    @Inject(KakaoAuthService) private readonly service: KakaoAuthService,
    @Inject(KakaoOidcClient) private readonly oidc: KakaoOidcClient,
  ) {}

  @Get('api/auth/kakao')
  @ApiOperation({
    summary: '카카오 로그인 시작',
    description:
      'OIDC state·nonce·PKCE 쿠키와 안전한 복귀 목적지를 설정한 뒤 카카오 인증 화면으로 이동합니다.',
  })
  @ApiResponse({
    status: 307,
    description: '카카오 인증 화면 또는 로그인 오류 화면으로 이동',
  })
  @ApiErrors([429])
  @ApiQuery({
    name: 'returnTo',
    schema: { type: 'string' },
    description:
      '허용된 /home, /invites, /settlements 내부 경로. 외부·인증 루프 경로는 /home으로 대체합니다.',
    required: false,
  })
  async login(
    @Req() request: Request,
    @Query('returnTo') returnTo: unknown,
    @Res() response: Response,
  ) {
    response.setHeader('Cache-Control', 'private, no-store');
    try {
      const config = getKakaoAuthenticationConfig(nodeRequestOrigin(request));
      const login = await this.oidc.authorize(config);
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
  @ApiOperation({
    summary: '카카오 로그인 콜백',
    description:
      '인가 코드를 교환하고 OIDC sub를 검증합니다. 가입 완료 활성 회원은 app JWT, 신규·가입 미완료·탈퇴 회원은 10분 onboarding JWT를 발급합니다. 로그인만으로 재가입하지 않습니다.',
    security: [
      { oidcStateCookie: [], oidcNonceCookie: [], oidcVerifierCookie: [] },
    ],
  })
  @ApiResponse({
    status: 307,
    description:
      '성공 시 안전한 원래 목적지 또는 /onboarding, 실패 시 목적지를 유지한 /login으로 이동',
  })
  @ApiQuery({
    name: 'code',
    required: true,
    schema: { type: 'string' },
    description: '카카오가 전달한 인가 코드',
  })
  @ApiQuery({
    name: 'state',
    required: true,
    schema: { type: 'string' },
    description: '로그인 시작 시 설정한 state 값',
  })
  @ApiQuery({
    name: 'error',
    required: false,
    schema: { type: 'string' },
    description: '카카오 인증 오류 코드',
  })
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
