import {
  Controller,
  Get,
  Post,
  Inject,
  Req,
  Res,
  HttpCode,
} from '@nestjs/common';
import type { Request, Response as ServerResponse } from 'express';
import { webRequest, sendResponse } from '../../apiPayload/httpContext';
import { ApiSuccess } from '../../apiPayload/apiResponse.interceptor';
import { AppError } from '../../apiPayload/errors';
import { accessTokenForRefresh } from '../authUtil';
import {
  setAuthCookies,
  clearAuthCookies,
  nativeCookieResponse,
} from './authCookies';
import { getKakaoLoginResponse } from './kakaoLogin.controller';
import { getKakaoCallbackResponse } from './kakaoCallback.controller';
import { getTestLoginResponse } from './testLogin.controller';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../decorator/currentUser.decorator';
import { AuthService } from '../service/auth.service';

@Controller()
export class AuthController {
  constructor(@Inject(AuthService) private readonly service: AuthService) {}
  @Get('api/auth/kakao')
  login(@Req() request: Request, @Res() response: ServerResponse) {
    return sendResponse(response, () =>
      getKakaoLoginResponse(webRequest(request)),
    );
  }
  @Get('auth/v1/kakao')
  callback(@Req() request: Request, @Res() response: ServerResponse) {
    return sendResponse(response, () =>
      getKakaoCallbackResponse(webRequest(request), this.service),
    );
  }
  @Post('api/auth/access-token')
  @HttpCode(200)
  @ApiSuccess({
    code: 'auth_ok',
    message: '인증 요청을 처리했어요',
    detail: null,
  })
  access(@CurrentUser() user: AuthenticatedUser) {
    return accessTokenForRefresh(user);
  }
  @Post('api/auth/refresh')
  @HttpCode(200)
  @ApiSuccess({
    code: 'auth_ok',
    message: '인증 요청을 처리했어요',
    detail: null,
  })
  refresh(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: ServerResponse,
  ) {
    try {
      const session = this.service.refreshTokens(user);
      const cookies = nativeCookieResponse(response);
      setAuthCookies(cookies, session);
      return { accessToken: session.accessToken };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        503,
        'refresh_unavailable',
        '인증 정보를 갱신하지 못했어요',
      );
    }
  }
  @Post('api/auth/logout')
  @HttpCode(200)
  @ApiSuccess({
    code: 'auth_ok',
    message: '인증 요청을 처리했어요',
    detail: null,
  })
  logout(@Res({ passthrough: true }) response: ServerResponse) {
    const cookies = nativeCookieResponse(response);
    clearAuthCookies(cookies, { returnTo: true });
    return { ok: true };
  }
  @Post('api/auth/test-login')
  testLogin(@Req() request: Request, @Res() response: ServerResponse) {
    return sendResponse(response, () =>
      getTestLoginResponse(webRequest(request), this.service),
    );
  }
}
