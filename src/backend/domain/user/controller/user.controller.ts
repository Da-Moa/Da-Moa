import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiDataResponse,
  ApiErrors,
  ApiMutationHeaders,
  ApiOrigin,
} from '../../../global/apiPayload/documentation.decorator';
import {
  Account,
  OnboardingResponseDTO,
  BankAccountResponseDTO,
  WithdrawResponseDTO,
} from '../dto/res/user.response.dto';
import { RequiredIdempotencyKey } from '../../../global/apiPayload/requiredHeader.decorator';
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
  Res,
  Body,
  HttpCode,
} from '@nestjs/common';
import type { Response as ServerResponse } from 'express';
import { after } from '../../../global/apiPayload/httpContext';
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
  Cookies,
  type AuthenticatedUser,
} from '../../../global/auth';
import { RealtimePublisher } from '../../../global/util/invalidationUtil';
import { GroupAudienceReader } from '../../group';
import { SettleAudienceReader } from '../../settle';
import { UserService } from '../service/user.service';

@RequestBodyLimit(16384)
@ApiSuccess(userSuccess)
@ApiBearerAuth('accessBearer')
@ApiTags('계정')
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
  @ApiOperation({
    summary: '본인 프로필·가입 상태·계좌 조회',
    description:
      'app 또는 onboarding 목적의 JWT로 본인 데이터만 조회합니다. 일반 기능은 가입 완료 회원의 app JWT가 필요합니다.',
    tags: ['계정'],
  })
  @ApiDataResponse(Account)
  @ApiErrors()
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.operations.getMe(user);
  }

  @JsonBody()
  @Post('api/me/onboarding')
  @HttpCode(200)
  @ApiOperation({
    summary: '계좌 저장 후 가입·명시적 재가입 완료',
    description:
      '은행·계좌번호·예금주를 직접 입력해 가입을 완료합니다. 계좌·가입 상태를 원자적으로 저장하고 새 app JWT를 발급하며 기존 모임·관리 권한은 복구하지 않습니다. 토큰 응답 유실은 카카오 재로그인으로 복구합니다.',
    tags: ['계정'],
  })
  @ApiDataResponse(OnboardingResponseDTO)
  @ApiErrors()
  @ApiOrigin()
  async onboarding(
    @CurrentUser() user: AuthenticatedUser,
    @Cookies(RETURN_TO_COOKIE_NAME) returnToCookie: string | undefined,
    @Body()
    body: OnboardingRequestDTO,
    @Res({ passthrough: true }) response: ServerResponse,
  ) {
    const returnTo = readReturnToCookie(returnToCookie);
    const session = await this.operations.completeOnboarding(user, body);
    after(() =>
      this.publisher.publishBankInvalidation(session.userId, (id) =>
        this.settlements.findRecipients(id),
      ),
    );
    setAuthCookies(response, session);
    clearReturnToCookie(response);
    return { id: session.userId, returnTo, accessToken: session.accessToken };
  }

  @JsonBody()
  @Put('api/me/bank-account')
  @ApiOperation({
    summary: '대표 계좌 저장',
    description:
      'AUTH 회원 조회 후 입력을 검증하고 expectedBankVersion이 일치하는 활성 회원의 계좌만 조건부 UPDATE합니다. 트랜잭션·명시적 락 없이 SQL 2회이며 갱신 실패는 409 bank_account_conflict입니다. 같은 버전의 재전송도 409이며 최신 내 정보를 다시 조회해야 합니다. 요청 키 형식만 검증하고 성공 기록은 조회·저장하지 않습니다. 계좌가 바뀌면 기존 확인 이력을 초기화하고, 진행 중 정산도 계좌 교체를 막지 않습니다.',
    tags: ['계정'],
  })
  @ApiDataResponse(BankAccountResponseDTO)
  @ApiErrors()
  @ApiMutationHeaders(
    '한 제출당 한 UUID. 네트워크·토큰 갱신 후 재시도에도 같은 키와 본문을 사용합니다.',
  )
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
  @ApiOperation({
    summary: '회원 탈퇴',
    description:
      'BEGIN → advisory transaction lock 획득 → AUTH → 미종료 참여 회차 조회 → 조건부 소프트 삭제·모임 이탈 단일 SQL → COMMIT의 6회입니다. 모임 탈퇴와 같은 락을 사용하며 성공 시 COMMIT, 실패 시 ROLLBACK으로 락을 자동 해제합니다. 참여 이력이 있는 미종료 회차가 있으면 제외 여부와 무관하게 409 unfinished_rounds로 차단합니다. deletedAt과 활성 멤버십 종료를 원자적으로 저장하고 클라이언트 토큰·쿠키를 삭제합니다. 동일 카카오 재가입 시 같은 ID·과거 기록을 유지하고 이전 모임·관리 권한은 복원하지 않습니다.',
    tags: ['인증'],
  })
  @ApiDataResponse(WithdrawResponseDTO, '탈퇴 완료')
  @ApiErrors([401, 429, 403, 409, 503])
  @ApiOrigin()
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
    clearAuthCookies(response, { returnTo: true, oidc: true });
    return { ok: true };
  }
}
