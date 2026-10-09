import {
  ApiCookieAuth,
  ApiExcludeEndpoint,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiDataResponse,
  ApiErrors,
  ApiOrigin,
} from '../../apiPayload/documentation.decorator';
import {
  AccessTokenResponseDTO,
  RefreshTokenResponseDTO,
  LogoutResponseDTO,
  RefreshUnauthorizedResponseDTO,
  RefreshUnavailableResponseDTO,
} from '../dto/res/auth.response.dto';
import {
  Controller,
  Post,
  Inject,
  Req,
  Res,
  HttpCode,
  Body,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response as ServerResponse } from 'express';
import { nodeRequestOrigin } from '../../apiPayload/http';
import {
  FormBody,
  RequestBodyLimit,
} from '../../apiPayload/requestBody.interceptor';
import { ApiSuccess } from '../../apiPayload/apiResponse.interceptor';
import { AppError } from '../../apiPayload/errors';
import { safeReturnTo } from '../authUtil';
import { setAuthCookies, clearAuthCookies } from './authCookies';
import { TestLoginGuard } from '../guard/testLogin.guard';
import type { TestLoginInput } from '../dto/req/testLogin.request.dto';
import { TestLoginBodyPipe } from '../pipe/testLoginBody.pipe';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../decorator/currentUser.decorator';
import { AuthService } from '../service/auth.service';

@ApiTags('인증')
@Controller()
export class AuthController {
  constructor(@Inject(AuthService) private readonly service: AuthService) {}
  @Post('api/auth/access-token')
  @HttpCode(200)
  @ApiSuccess({
    code: 'auth_ok',
    message: '인증 요청을 처리했어요',
    detail: null,
  })
  @ApiOperation({
    summary: '로그인 완료 후 Access JWT 전달',
    description:
      'Refresh JWT의 서명·만료를 확인해 app/onboarding 목적을 보존한 Access JWT를 JSON으로 전달합니다. 브라우저가 localStorage에 저장하며 URL·Access 쿠키에 토큰을 넣지 않습니다.',
  })
  @ApiDataResponse(
    AccessTokenResponseDTO,
    'data.accessToken과 data.purpose 반환',
  )
  @ApiOrigin()
  @ApiCookieAuth('refreshCookie')
  @ApiResponse({
    status: 401,
    description: '유효하지 않거나 만료된 인증 정보',
    type: RefreshUnauthorizedResponseDTO,
    example: { error: 'unauthorized' },
  })
  @ApiErrors([403, 429, 503])
  access(@CurrentUser() user: AuthenticatedUser) {
    return this.service.accessTokenForRefresh(user);
  }
  @Post('api/auth/refresh')
  @HttpCode(200)
  @ApiSuccess({
    code: 'auth_ok',
    message: '인증 요청을 처리했어요',
    detail: null,
  })
  @ApiOperation({
    summary: '액세스 토큰 재발급',
    description:
      'Node JWT Guard에서 리프레시 JWT의 서명·만료를 먼저 검증합니다. DB 세션 없이 JWT의 목적을 보존해 Access JWT를 JSON으로 반환하고 Refresh 쿠키를 갱신합니다. app Refresh는 14일로 갱신하고 onboarding Refresh의 원래 만료 시각은 연장하지 않습니다. 이전 Refresh JWT도 자체 만료까지 유효합니다.',
  })
  @ApiDataResponse(
    RefreshTokenResponseDTO,
    'data.accessToken을 반환하고 Refresh 쿠키 갱신',
  )
  @ApiOrigin()
  @ApiCookieAuth('refreshCookie')
  @ApiResponse({
    status: 401,
    description: '유효하지 않거나 만료된 인증 정보',
    type: RefreshUnauthorizedResponseDTO,
    example: { error: 'unauthorized' },
  })
  @ApiErrors([403, 429])
  @ApiResponse({
    status: 503,
    description:
      '액세스 토큰 재발급 실패. 인증 설정·일시적 서버 오류 확인 후 재시도',
    type: RefreshUnavailableResponseDTO,
    example: {
      error: 'refresh_unavailable',
      code: 'refresh_unavailable',
      detail: null,
      message: '인증 정보를 갱신하지 못했어요',
    },
  })
  refresh(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: ServerResponse,
  ) {
    try {
      const session = this.service.refreshTokens(user);
      setAuthCookies(response, session);
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
  @ApiOperation({
    summary: '로그아웃',
    description:
      'Node JWT Guard에서 유효한 Refresh 또는 Bearer Access JWT를 요구합니다. 브라우저는 성공 후 localStorage의 Access 토큰을 삭제하고 서버는 Refresh 쿠키를 삭제합니다. DB 세션을 사용하거나 Access JWT를 즉시 만료시키지 않으며 발급 후 10분까지 유효합니다.',
    security: [{ refreshCookie: [] }, { accessBearer: [] }],
  })
  @ApiDataResponse(LogoutResponseDTO, '로그아웃 완료')
  @ApiOrigin()
  @ApiErrors([401, 403, 429])
  logout(@Res({ passthrough: true }) response: ServerResponse) {
    clearAuthCookies(response, { returnTo: true });
    return { ok: true };
  }
  @ApiExcludeEndpoint()
  @Post('api/auth/test-login')
  @UseGuards(TestLoginGuard)
  @FormBody()
  @RequestBodyLimit(4096)
  async testLogin(
    @Body(TestLoginBodyPipe) body: TestLoginInput,
    @Req() request: Request,
    @Res() response: ServerResponse,
  ) {
    const expected = nodeRequestOrigin(request);
    if (!expected)
      throw new AppError(403, 'forbidden', '허용되지 않은 요청입니다');
    const session = await this.service.signInTestAccount(body.key);
    const destination = new URL(
      `/auth/complete?returnTo=${encodeURIComponent(safeReturnTo(body.returnTo))}`,
      expected,
    );
    setAuthCookies(response, session);
    response.setHeader('Cache-Control', 'private, no-store');
    response.redirect(303, destination.toString());
  }
}
