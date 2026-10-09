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
import {
  setAuthCookies,
  clearAuthCookies,
  nativeCookieResponse,
} from './authCookies';
import { TestLoginGuard } from '../guard/testLogin.guard';
import type { TestLoginInput } from '../dto/req/testLogin.request.dto';
import { TestLoginBodyPipe } from '../pipe/testLoginBody.pipe';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../decorator/currentUser.decorator';
import { AuthService } from '../service/auth.service';

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
    setAuthCookies(nativeCookieResponse(response), session);
    response.setHeader('Cache-Control', 'private, no-store');
    response.redirect(303, destination.toString());
  }
}
