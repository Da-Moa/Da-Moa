import { RequiredIdempotencyKey } from '../../../global/apiPayload/requiredHeader.decorator';
import { RequestBodyLimit } from '../../../global/apiPayload/requestBody.interceptor';
import {
  Controller,
  Get,
  Post,
  Put,
  Inject,
  Req,
  Res,
  Body,
  HttpCode,
} from '@nestjs/common';
import type { Request, Response as ServerResponse } from 'express';
import {
  after,
  webRequest,
  HttpResponse,
  copyResponseCookies,
} from '../../../global/apiPayload/httpContext';
import { ApiSuccess } from '../../../global/apiPayload/apiResponse.interceptor';
import {
  BankAccountRequestDTO,
  OnboardingRequestDTO,
} from '../dto/req/user.request.dto';
import { userSuccess } from '../code/user.success.code';
import {
  RETURN_TO_COOKIE_NAME,
  setAuthCookies,
  clearAuthCookies,
  clearReturnToCookie,
  readReturnToCookie,
  CurrentUser,
  type AuthenticatedUser,
} from '../../../global/auth';
import { publishBankInvalidation } from './userInvalidation';
import { publishDepartureInvalidation } from '../../group';
import { UserService } from '../service/user.service';

@RequestBodyLimit(16384)
@ApiSuccess(userSuccess)
@Controller()
export class UserController {
  constructor(@Inject(UserService) private readonly operations: UserService) {}

  @Get('api/me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.operations.getMe(user);
  }

  @Post('api/me/onboarding')
  @HttpCode(200)
  async onboarding(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
    @Body()
    body: OnboardingRequestDTO,
    @Res({ passthrough: true }) response: ServerResponse,
  ) {
    const web = webRequest(request);
    const returnTo = readReturnToCookie(
      web.cookies.get(RETURN_TO_COOKIE_NAME)?.value,
    );
    const session = await this.operations.completeOnboarding(user, body);
    after(() => publishBankInvalidation(session.userId));
    const cookies = new HttpResponse(null);
    setAuthCookies(cookies, session);
    clearReturnToCookie(cookies);
    copyResponseCookies(response, cookies);
    return { id: session.userId, returnTo, accessToken: session.accessToken };
  }

  @Put('api/me/bank-account')
  async bank(
    @CurrentUser() user: AuthenticatedUser,
    @RequiredIdempotencyKey() idempotencyKey: string,
    @Body()
    body: BankAccountRequestDTO,
  ) {
    const result = await this.operations.updateBankAccount(
      user,
      idempotencyKey,
      body,
    );
    after(() => publishBankInvalidation(result.id));
    return result;
  }

  @Post('api/auth/withdraw')
  @HttpCode(200)
  async withdraw(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: ServerResponse,
  ) {
    const result = await this.operations.withdrawAccount(user);
    after(() => publishDepartureInvalidation(result.groupIds));
    const cookies = new HttpResponse(null);
    clearAuthCookies(cookies, { returnTo: true, oidc: true });
    copyResponseCookies(response, cookies);
    return { ok: true };
  }
}
