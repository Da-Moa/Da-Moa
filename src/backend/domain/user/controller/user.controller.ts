import { RequiredIdempotencyKey } from '../../../global/apiPayload/requiredHeader.decorator';
import { RequestCookies } from '@edge-runtime/cookies';
import {
  JsonBody,
  RequestBodyLimit,
} from '../../../global/apiPayload/requestBody.interceptor';
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
import { after } from '../../../global/apiPayload/httpContext';
import { nativeCookieResponse } from '../../../global/auth/controller/authCookies';
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
import { RealtimePublisher } from '../../../global/util/invalidationUtil';
import { GroupAudienceReader } from '../../group';
import { SettleAudienceReader } from '../../settle';
import { UserService } from '../service/user.service';

@RequestBodyLimit(16384)
@ApiSuccess(userSuccess)
@Controller()
export class UserController {
  constructor(
    @Inject(UserService) private readonly operations: UserService,
    @Inject(GroupAudienceReader) private readonly groups: GroupAudienceReader,
    @Inject(SettleAudienceReader)
    private readonly settlements: SettleAudienceReader,
    @Inject(RealtimePublisher) private readonly publisher: RealtimePublisher,
  ) {}

  @Get('api/me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.operations.getMe(user);
  }

  @JsonBody()
  @Post('api/me/onboarding')
  @HttpCode(200)
  async onboarding(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
    @Body()
    body: OnboardingRequestDTO,
    @Res({ passthrough: true }) response: ServerResponse,
  ) {
    const returnTo = readReturnToCookie(
      new RequestCookies(
        new Headers({ cookie: request.headers.cookie ?? '' }),
      ).get(RETURN_TO_COOKIE_NAME)?.value,
    );
    const session = await this.operations.completeOnboarding(user, body);
    after(() =>
      this.publisher.publishBankInvalidation(session.userId, (id) =>
        this.settlements.findRecipients(id),
      ),
    );
    const cookies = nativeCookieResponse(response);
    setAuthCookies(cookies, session);
    clearReturnToCookie(cookies);
    return { id: session.userId, returnTo, accessToken: session.accessToken };
  }

  @JsonBody()
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
    after(() =>
      this.publisher.publishBankInvalidation(result.id, (id) =>
        this.settlements.findRecipients(id),
      ),
    );
    return result;
  }

  @Post('api/auth/withdraw')
  @HttpCode(200)
  async withdraw(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: ServerResponse,
  ) {
    const result = await this.operations.withdrawAccount(user);
    after(() =>
      this.publisher.publishDepartureInvalidation(result.groupIds, (ids) =>
        this.groups.findRecipients(ids),
      ),
    );
    const cookies = nativeCookieResponse(response);
    clearAuthCookies(cookies, { returnTo: true, oidc: true });
    return { ok: true };
  }
}
