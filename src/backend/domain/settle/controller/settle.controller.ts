import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
} from '@nestjs/swagger';
import {
  ApiDataResponse,
  ApiErrors,
  ApiMutationHeaders,
} from '../../../global/apiPayload/documentation.decorator';
import {
  RoundPage,
  RoundDetail,
  SettlementDTO,
  ExclusionCheck,
  MutationResult,
} from '../dto/res/settle.response.dto';
import { JsonBody } from '../../../global/apiPayload/requestBody.interceptor';
import { RequiredIdempotencyKey } from '../../../global/apiPayload/requiredHeader.decorator';
import { PageQueryDTO } from '../../../global/apiPayload/dto/req/page.request.dto';
import { parsePageQuery } from '../../../global/apiPayload/pageQuery';
import {
  Controller,
  Body,
  Query,
  HttpCode,
  StreamableFile,
  Get,
  Post,
  Patch,
  Delete,
  Inject,
  UploadedFile,
  UseInterceptors,
  Res,
  Param,
} from '@nestjs/common';
import type { Response as ServerResponse } from 'express';
import { after } from '../../../global/apiPayload/httpContext';
import { CurrentUser, type AuthenticatedUser } from '../../../global/auth';
import {
  CurrentReceiptAdmission,
  ReceiptUploadInterceptor,
  type ReceiptFile,
} from './receiptUpload.interceptor';
import {
  SettleService,
  type ReceiptAdmission,
} from '../service/settle.service';
import {
  CreateRoundRequestDTO,
  RoundListQueryDTO,
  parseRoundListQuery,
  ExpenseRequestDTO,
  CreateExpenseRequestDTO,
  SettlementCheckRequestDTO,
  VersionRequestDTO,
  ReceiptUploadRequestDTO,
} from '../dto/req/settle.request.dto';
import { settleErrors } from '../code/settle.error.code';
import { settleSuccess } from '../code/settle.success.code';
import {
  ApiSuccess,
  RawApiResponse,
} from '../../../global/apiPayload/apiResponse.interceptor';
import { RealtimePublisher, type RoundAudience } from '../../../global/util';
@ApiSuccess(settleSuccess)
@ApiBearerAuth('accessBearer')
@Controller()
export class SettleController {
  constructor(
    @Inject(SettleService) private readonly service: SettleService,
    @Inject(RealtimePublisher) private readonly publisher: RealtimePublisher,
  ) {}

  @Get('api/groups/:groupId/rounds')
  @ApiOperation({
    summary: '본인 참여 권한이 있는 모임 회차 목록',
    description:
      'Node JWT Guard에서 입력 검사 전에 JWT를 검증하고, DB에서 회원 상태 및 리소스 권한을 검증하며 세션 유효성은 조회하지 않습니다. 응답은 private, no-store입니다.',
    tags: ['모임'],
  })
  @ApiDataResponse(RoundPage)
  @ApiErrors()
  @ApiParam({
    name: 'groupId',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description: '(created_at, id)에 기반한 서버 발급 커서',
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description: '모임명 또는 회차명의 대소문자를 구분하지 않는 부분 검색어',
  })
  listGroupRounds(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: RoundListQueryDTO,
    @Param('groupId') groupId: string,
  ) {
    return this.service.listRounds(user, parseRoundListQuery(query), groupId);
  }

  @JsonBody()
  @Post('api/groups/:groupId/rounds')
  @HttpCode(200)
  @ApiOperation({
    summary: '선택한 멤버로 기록 시작',
    description:
      'DTO 구조 검증 후 BEGIN → transaction advisory lock 획득 → AUTH 내 정보 조회 → 참여 권한·UUIDv7 키 검증 → 단일 조건부 SQL로 회차와 참여자 저장 → COMMIT의 SQL 5회입니다. 모임 이탈·닫기·회원 탈퇴와 같은 락으로 AUTH부터 저장까지 보호하며 COMMIT 또는 ROLLBACK에서 자동 해제합니다. Prisma 트랜잭션을 사용하고 별도 멱등 성공 기록 없이 ticket을 PK로 사용하며 중복 PK는 409 round_already_exists입니다. 없는/탈퇴한 요청자는 401 unauthorized, 비멤버·없는 모임은 404 not_found, 비활성·외부 참여자는 400 invalid_participants입니다. 응답 유실 후 같은 ticket 재시도도 409이며 회차 목록에서 결과를 확인합니다. 모임 이탈·회원 탈퇴와는 같은 transaction advisory lock으로 직렬화합니다. 모든 활성 모임 참여자가 요청자 자신을 포함한 최소 2명을 선택해 회차를 만들 수 있습니다. 요청자가 회차 생성자가 되어 해당 회차 수명주기와 전체 지출을 관리하며, 모임 생성자는 필수 참여자가 아닙니다. 회차 생성 요청에는 통화를 받지 않습니다. 각 지출에서 지원 통화를 선택하고 기록 단계에서 변경할 수 있으며 한 회차에 최대 5개 통화를 기록합니다. 미완료 회차가 있어도 생성할 수 있습니다.',
    tags: ['모임'],
  })
  @ApiDataResponse(MutationResult)
  @ApiErrors()
  @ApiMutationHeaders(
    '회차 PK로 사용할 UUIDv7 ticket. Idempotency-Key 헤더로 전달하며 같은 키 재전송은 409로 거절합니다.',
  )
  @ApiParam({
    name: 'groupId',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  async createRound(
    @CurrentUser() user: AuthenticatedUser,
    @RequiredIdempotencyKey(settleErrors.ROUND_CREATION_KEY_REQUIRED)
    idempotencyKey: string,
    @Body()
    body: CreateRoundRequestDTO,
    @Param('groupId') groupId: string,
  ) {
    let audience: RoundAudience | null = null;
    const result = await this.service.createRound(
      user,
      idempotencyKey,
      groupId,
      body,
      (ids) => {
        audience = { groupId, userIds: ids };
      },
    );
    if (this.publisher.realtimeEnabled())
      after(() =>
        this.publisher.publishRoundInvalidation(result.id, audience, false),
      );
    return result;
  }

  @Get('api/rounds')
  @ApiOperation({
    summary: '본인 참여 이력으로 회차 목록 조회',
    description:
      '현재 모임 멤버십과 무관하게 본인 참여 이력이 있는 회차를 조회합니다. 다른 회차·통화 금액을 합산하지 않습니다.',
    tags: ['정산'],
  })
  @ApiDataResponse(RoundPage)
  @ApiErrors()
  @ApiQuery({
    name: 'cursor',
    required: false,
    description: '(created_at, id)에 기반한 서버 발급 커서',
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description: '모임명 또는 회차명의 대소문자를 구분하지 않는 부분 검색어',
  })
  listRounds(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: RoundListQueryDTO,
  ) {
    return this.service.listRounds(user, parseRoundListQuery(query));
  }

  @Get('api/rounds/:roundId')
  @ApiOperation({
    summary: '회차·지출·참여 내역 조회',
    description:
      'creatorId는 회차 생성자, groupCreatorId는 모임 생성자이며 isCreator는 조회 사용자가 회차 생성자인지를 뜻합니다. 같은 DB 스냅샷의 원본과 버전을 반환합니다. 회차 참여자의 이름과 활성 회원의 최신 카카오 프로필 이미지를 반환하며 탈퇴자의 이미지는 null입니다. 최종화 전에는 각 지출의 균등 기본 몫과 개별 지정 부담금을 회차 전체에서 상계한 예상 송금 관계와 미배분 나머지 금액을, 최종화 뒤에는 저장된 최종 관계를 반환합니다. 송금 관계는 조회 사용자가 보내거나 받는 행만 포함하며 계좌정보는 반환하지 않습니다.',
    tags: ['정산'],
  })
  @ApiDataResponse(RoundDetail)
  @ApiErrors()
  @ApiParam({
    name: 'roundId',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description: '(created_at, id)에 기반한 서버 발급 커서',
  })
  getRound(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PageQueryDTO,
    @Param('roundId') roundId: string,
  ) {
    return this.service.getRound(user, roundId, parsePageQuery(query));
  }

  @JsonBody()
  @Delete('api/rounds/:roundId')
  @HttpCode(200)
  @ApiOperation({
    summary: '기록 단계 회차 전체 취소',
    description:
      '회차 생성자만 지출 기록이 없는 RECORDING 회차를 취소합니다. 지출이 있으면 409 round_has_expenses로 거절하며 지출을 먼저 삭제해야 합니다. 재오픈 후에도 지출이 없어야 취소 가능하며 같은 키 재시도는 기존 성공 결과를 반환합니다. BEGIN → AUTH → 락 → 기록·권한·버전·재시도 조회 → 삭제·성공 기록 저장 → COMMIT의 SQL 6회이며 거절은 ROLLBACK으로 락을 해제합니다.',
    tags: ['정산'],
  })
  @ApiDataResponse(MutationResult)
  @ApiErrors()
  @ApiMutationHeaders()
  @ApiParam({
    name: 'roundId',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  async cancelRound(
    @CurrentUser() user: AuthenticatedUser,
    @RequiredIdempotencyKey() idempotencyKey: string,
    @Body() body: VersionRequestDTO,
    @Param('roundId') roundId: string,
  ) {
    let audience: RoundAudience | null = null;
    const result = await this.service.roundCommand(
      user,
      idempotencyKey,
      roundId,
      'cancel',
      body,
      (value) => {
        audience = value;
      },
    );
    if (this.publisher.realtimeEnabled())
      after(() =>
        this.publisher.publishRoundInvalidation(roundId, audience, false),
      );
    return result;
  }

  @Get('api/rounds/:roundId/settlement')
  @ApiOperation({
    summary: '본인의 개인 지급·수취 안내',
    description:
      '최종 저장 전에는 대기 상태만 반환합니다. 최종 금액은 고정하며 KRW에서는 본인이 지급할 수취인의 최신 계좌만 조회합니다. 지급·수취 상대의 이름과 활성 회원의 최신 카카오 프로필 이미지를 반환하고 탈퇴자의 이미지는 null로 반환합니다. 각 수취 건의 확인 시각과 수취인별 전체 완료 상태를 반환하며, 강제 종료 뒤에도 미확인 건은 null로 보존합니다. KRW 이외 통화와 수취 내역에는 계좌 필드가 없습니다. 모임·회차 생성자도 같은 공개 범위이며 링크는 로그인한 본인의 정보만 보여 줍니다.',
    tags: ['정산'],
  })
  @ApiDataResponse(SettlementDTO)
  @ApiErrors()
  @ApiParam({
    name: 'roundId',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  getSettlement(
    @CurrentUser() user: AuthenticatedUser,
    @Param('roundId') roundId: string,
  ) {
    return this.service.getSettlement(user, roundId);
  }

  @JsonBody()
  @Post('api/rounds/:roundId/settlement-check')
  @HttpCode(200)
  @ApiOperation({
    summary: '본인의 송금 건별 수취 확인 설정',
    description:
      '최종 금액이 저장된 LOCKED 회차에서 수취인 본인만 확인을 설정하거나 해제합니다. senderId와 currency를 지정하면 해당 송금자의 해당 통화 건만, 생략하면 본인의 수취 건 중 확인 상태가 다른 건을 변경합니다. AUTH → 수취 목록/권한 조회 → 단일 조건부 UPDATE의 SQL 3회이며 명시적 트랜잭션·락·멱등 성공 기록은 없습니다. 이미 요청한 확인 상태라 변경할 기록이 없으면 같은 키·새 키 모두 404 not_found입니다. 원본 잔액은 보존하고 확인 시각으로 남은 금액을 계산하며 회차 version은 올리지 않습니다. 완료 후에는 변경할 수 없습니다.',
    tags: ['정산'],
  })
  @ApiDataResponse(MutationResult)
  @ApiErrors()
  @ApiMutationHeaders()
  @ApiParam({
    name: 'roundId',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  async setSettlementCheck(
    @CurrentUser() user: AuthenticatedUser,
    @RequiredIdempotencyKey() idempotencyKey: string,
    @Body()
    body: SettlementCheckRequestDTO,
    @Param('roundId') roundId: string,
  ) {
    let audience: RoundAudience | null = null;
    const result = await this.service.setSettlementCheck(
      user,
      idempotencyKey,
      roundId,
      body,
      (value) => {
        audience = value;
      },
    );
    if (this.publisher.realtimeEnabled())
      after(() =>
        this.publisher.publishRoundInvalidation(roundId, audience, true),
      );
    return result;
  }

  @JsonBody()
  @Post('api/rounds/:roundId/confirm')
  @HttpCode(200)
  @ApiOperation({
    summary: '정산 확정',
    description:
      '회차 생성자가 RECORDING 회차의 모든 지출을 재검증하고 기본 몫·나머지를 저장합니다. CUSTOM은 원본 부담금 합계를 검증하고 나머지를 만들지 않습니다. 지출 0건이면 409 empty_expenses와 지출 내역이 없습니다 메시지를 반환합니다. 이 단계에서는 추첨하지 않습니다.',
    tags: ['정산'],
  })
  @ApiDataResponse(MutationResult)
  @ApiErrors()
  @ApiMutationHeaders()
  @ApiParam({
    name: 'roundId',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  async confirmRound(
    @CurrentUser() user: AuthenticatedUser,
    @RequiredIdempotencyKey() idempotencyKey: string,
    @Body() body: VersionRequestDTO,
    @Param('roundId') roundId: string,
  ) {
    let audience: RoundAudience | null = null;
    const result = await this.service.roundCommand(
      user,
      idempotencyKey,
      roundId,
      'confirm',
      body,
      (value) => {
        audience = value;
      },
    );
    if (this.publisher.realtimeEnabled())
      after(() =>
        this.publisher.publishRoundInvalidation(roundId, audience, false),
      );
    return result;
  }

  @JsonBody()
  @Post('api/rounds/:roundId/reopen')
  @HttpCode(200)
  @ApiOperation({
    summary: '확정 회차를 기록 단계로 재오픈',
    description:
      'AUTH → 회차 조회 → 회차 생성자·상태·버전 검사 → 단일 저장 SQL 3회로 처리하며 명시적 트랜잭션·락은 없습니다. 회차 생성자만 미전송·미종료 CONFIRMED 회차를 RECORDING으로 되돌립니다. 기본 몫·나머지 초기화와 상태·버전 증가를 원자적으로 저장하고 개별 지정 부담금을 포함한 지출 원본·증빙은 유지합니다. 성공 응답을 재생하지 않으며 같은 키/새 키 재요청은 이미 기록 중인 상태에서 409 invalid_round_state로 거절합니다. 동시 변경은 409 stale_round입니다. 이후 수정 → 확정 흐름을 다시 따릅니다.',
    tags: ['정산'],
  })
  @ApiDataResponse(MutationResult)
  @ApiErrors()
  @ApiMutationHeaders()
  @ApiParam({
    name: 'roundId',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  async reopenRound(
    @CurrentUser() user: AuthenticatedUser,
    @RequiredIdempotencyKey() idempotencyKey: string,
    @Body() body: VersionRequestDTO,
    @Param('roundId') roundId: string,
  ) {
    let audience: RoundAudience | null = null;
    const result = await this.service.roundCommand(
      user,
      idempotencyKey,
      roundId,
      'reopen',
      body,
      (value) => {
        audience = value;
      },
    );
    if (this.publisher.realtimeEnabled())
      after(() =>
        this.publisher.publishRoundInvalidation(roundId, audience, false),
      );
    return result;
  }

  @JsonBody()
  @Post('api/rounds/:roundId/send')
  @HttpCode(200)
  @ApiOperation({
    summary: '전송을 확인하고 회차 잠금',
    description:
      '회차 생성자가 CONFIRMED 회차를 LOCKED로 전환합니다. 실제 메시지를 전송하지 않습니다. 원본·참여자 수정과 재오픈·취소는 이후 불가합니다. 나머지가 없으면 결과를 함께 저장하고, 있으면 추첨 전 최종 안내·링크를 제공하지 않습니다.',
    tags: ['정산'],
  })
  @ApiDataResponse(MutationResult)
  @ApiErrors()
  @ApiMutationHeaders()
  @ApiParam({
    name: 'roundId',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  async sendRound(
    @CurrentUser() user: AuthenticatedUser,
    @RequiredIdempotencyKey() idempotencyKey: string,
    @Body() body: VersionRequestDTO,
    @Param('roundId') roundId: string,
  ) {
    let audience: RoundAudience | null = null;
    const result = await this.service.roundCommand(
      user,
      idempotencyKey,
      roundId,
      'send',
      body,
      (value) => {
        audience = value;
      },
    );
    if (this.publisher.realtimeEnabled())
      after(() =>
        this.publisher.publishRoundInvalidation(roundId, audience, false),
      );
    return result;
  }

  @JsonBody()
  @Post('api/rounds/:roundId/draw')
  @HttpCode(200)
  @ApiOperation({
    summary: '잠긴 회차의 나머지를 한 번 추첨',
    description:
      'AUTH → 회차 조회 → 회차 생성자·버전·LOCKED 검사 → 단일 저장 SQL 3회로 처리합니다. 서버 난수로 각 지출의 서로 다른 균등 부담자에게 최소 단위 1을 배분하고 CUSTOM 지정 부담금은 유지합니다. 최종 분담·잔액·송금·finalizedAt·버전·멱등 응답을 한 SQL로 원자적으로 저장해 정산 안내를 준비합니다. 명시적 BEGIN/COMMIT·공통 advisory lock 없이 저장 SQL 안에서 해당 회차 행만 잠그며, 이미 저장했다면 다른 키여도 다시 추첨하지 않습니다.',
    tags: ['정산'],
  })
  @ApiDataResponse(MutationResult)
  @ApiErrors()
  @ApiMutationHeaders()
  @ApiParam({
    name: 'roundId',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  async drawRound(
    @CurrentUser() user: AuthenticatedUser,
    @RequiredIdempotencyKey() idempotencyKey: string,
    @Body() body: VersionRequestDTO,
    @Param('roundId') roundId: string,
  ) {
    let audience: RoundAudience | null = null;
    const result = await this.service.roundCommand(
      user,
      idempotencyKey,
      roundId,
      'draw',
      body,
      (value) => {
        audience = value;
      },
    );
    if (this.publisher.realtimeEnabled())
      after(() =>
        this.publisher.publishRoundInvalidation(roundId, audience, false),
      );
    return result;
  }

  @JsonBody()
  @Post('api/rounds/:roundId/complete')
  @HttpCode(200)
  @ApiOperation({
    summary: '모든 송금 수취 확인 후 정산 종료',
    description:
      'AUTH → 미확인 수취 검사와 조건부 종료를 합친 단일 SQL의 총 2회이며 명시적 트랜잭션·락은 없습니다. 종료 UPDATE 안에서 미확인 수취가 없는지 검사하며, 남으면 저장하지 않고 409 pending_settlement_checks로 거절합니다. 회차 생성자만 최종 금액이 저장된 LOCKED 회차에서 모든 송금 건의 수취가 확인된 경우 COMPLETED로 바꿉니다. 상태·종료 시각·버전 증가·멱등 성공 기록을 한 SQL로 저장하고 같은 키/본문은 기존 결과를 재생합니다. 거절·성공 재생도 총 2회입니다. 송금 건이 없으면 별도 확인 없이 종료할 수 있습니다. 완료 데이터는 누구도 수정할 수 없고 해당 회차의 탈퇴 차단을 해제합니다.',
    tags: ['정산'],
  })
  @ApiDataResponse(MutationResult)
  @ApiErrors()
  @ApiMutationHeaders()
  @ApiParam({
    name: 'roundId',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  async completeRound(
    @CurrentUser() user: AuthenticatedUser,
    @RequiredIdempotencyKey() idempotencyKey: string,
    @Body() body: VersionRequestDTO,
    @Param('roundId') roundId: string,
  ) {
    let audience: RoundAudience | null = null;
    const result = await this.service.roundCommand(
      user,
      idempotencyKey,
      roundId,
      'complete',
      body,
      (value) => {
        audience = value;
      },
    );
    if (this.publisher.realtimeEnabled())
      after(() =>
        this.publisher.publishRoundInvalidation(roundId, audience, false),
      );
    return result;
  }

  @JsonBody()
  @Post('api/rounds/:roundId/force-complete')
  @HttpCode(200)
  @ApiOperation({
    summary: '정산 강제 종료',
    description:
      '회차 생성자만 최종 금액이 저장된 LOCKED 회차를 수취 확인과 무관하게 COMPLETED로 바꿉니다. 미확인 송금 건은 null로 보존하며 완료 후 누구도 확인이나 정산 데이터를 변경할 수 없습니다.',
    tags: ['정산'],
  })
  @ApiDataResponse(MutationResult)
  @ApiErrors()
  @ApiMutationHeaders()
  @ApiParam({
    name: 'roundId',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  async forceCompleteRound(
    @CurrentUser() user: AuthenticatedUser,
    @RequiredIdempotencyKey() idempotencyKey: string,
    @Body() body: VersionRequestDTO,
    @Param('roundId') roundId: string,
  ) {
    let audience: RoundAudience | null = null;
    const result = await this.service.roundCommand(
      user,
      idempotencyKey,
      roundId,
      'force-complete',
      body,
      (value) => {
        audience = value;
      },
    );
    if (this.publisher.realtimeEnabled())
      after(() =>
        this.publisher.publishRoundInvalidation(roundId, audience, false),
      );
    return result;
  }

  @JsonBody()
  @Post('api/rounds/:roundId/expenses')
  @HttpCode(200)
  @ApiOperation({
    summary: '지출 생성',
    description:
      '기록 단계의 제외되지 않은 참여자가 작성합니다. 결제자 한 명과 전체·선택 사용자 균등 분배 또는 개별 항목 분배(CUSTOM)를 지정하며 작성자는 로그인 사용자로 저장합니다. CUSTOM은 participantIds 대신 customShares의 부담자·금액을 받으며 총 금액과 다르면 400 custom_share_total_mismatch와 “부담금 합계가 총 금액과 일치해야 해요”를 반환합니다. 통화 주 단위 기준 한 건은 100,000,000 이하, 통화별 회차 누적은 1,000,000,000 이하만 허용합니다. currency는 지원 통화 중 하나여야 하며 한 회차의 통화 종류는 최대 5개입니다. 저장 SQL에서도 통화별 합계와 종류 수를 재검사합니다.',
    tags: ['지출'],
  })
  @ApiDataResponse(MutationResult)
  @ApiErrors()
  @ApiMutationHeaders()
  @ApiParam({
    name: 'roundId',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  async createExpense(
    @CurrentUser() user: AuthenticatedUser,
    @RequiredIdempotencyKey() idempotencyKey: string,
    @Body() body: CreateExpenseRequestDTO,
    @Param('roundId') roundId: string,
  ) {
    let audience: RoundAudience | null = null;
    const result = await this.service.createExpense(
      user,
      idempotencyKey,
      roundId,
      body,
      (value) => {
        audience = value;
      },
    );
    if (this.publisher.realtimeEnabled())
      after(() =>
        this.publisher.publishRoundInvalidation(roundId, audience, false),
      );
    return result;
  }

  @JsonBody()
  @Patch('api/rounds/:roundId/expenses/:expenseId')
  @HttpCode(200)
  @ApiOperation({
    summary: '지출 수정',
    description:
      '기록 단계에서 제외되지 않은 원작성자 또는 해당 회차 생성자만 수정합니다. 모임 생성자라는 이유만으로 수정할 수 없으며 작성자·회차는 변경할 수 없으며 지출 통화는 변경할 수 있습니다. 통화 변경 시 amount, 기존 CUSTOM의 경우 customShares도 다시 입력해야 합니다. 수정 금액으로 기존 금액을 대체해 한 건 100,000,000·회차 누적 1,000,000,000 한도를 다시 검증합니다. 기존 제외된 비부담 결제자의 관계는 보존할 수 있습니다. 기존 CUSTOM 수정에서 customShares를 생략하면 원본 부담금을 유지하되 변경된 총 금액과 합계를 다시 비교합니다. CUSTOM 전환은 customShares가 필수이고 ALL·SELECTED 전환 시 지정 부담금을 제거합니다.',
    tags: ['지출'],
  })
  @ApiDataResponse(MutationResult)
  @ApiErrors()
  @ApiMutationHeaders()
  @ApiParam({
    name: 'roundId',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiParam({
    name: 'expenseId',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  async updateExpense(
    @CurrentUser() user: AuthenticatedUser,
    @RequiredIdempotencyKey() idempotencyKey: string,
    @Body() body: ExpenseRequestDTO,
    @Param('roundId') roundId: string,
    @Param('expenseId') expenseId: string,
  ) {
    let audience: RoundAudience | null = null;
    const result = await this.service.updateExpense(
      user,
      idempotencyKey,
      roundId,
      body,
      expenseId,
      (value) => {
        audience = value;
      },
    );
    if (this.publisher.realtimeEnabled())
      after(() =>
        this.publisher.publishRoundInvalidation(roundId, audience, false),
      );
    return result;
  }

  @JsonBody()
  @Delete('api/rounds/:roundId/expenses/:expenseId')
  @HttpCode(200)
  @ApiOperation({
    summary: '지출·분담·증빙 삭제',
    description:
      '기록 단계에서 제외되지 않은 원작성자 또는 해당 회차 생성자만 지출과 연결 자료를 삭제합니다. 모임 생성자라는 이유만으로 삭제할 수 없습니다.',
    tags: ['지출'],
  })
  @ApiDataResponse(MutationResult)
  @ApiErrors()
  @ApiMutationHeaders()
  @ApiParam({
    name: 'roundId',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiParam({
    name: 'expenseId',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  async deleteExpense(
    @CurrentUser() user: AuthenticatedUser,
    @RequiredIdempotencyKey() idempotencyKey: string,
    @Body() body: VersionRequestDTO,
    @Param('roundId') roundId: string,
    @Param('expenseId') expenseId: string,
  ) {
    let audience: RoundAudience | null = null;
    const result = await this.service.deleteExpense(
      user,
      idempotencyKey,
      roundId,
      expenseId,
      body,
      (value) => {
        audience = value;
      },
    );
    if (this.publisher.realtimeEnabled())
      after(() =>
        this.publisher.publishRoundInvalidation(roundId, audience, false),
      );
    return result;
  }

  @Get('api/rounds/:roundId/members/:userId/exclusion-check')
  @ApiOperation({
    summary: '회차 사용자 제외 가능 여부와 관련 지출 확인',
    description:
      '회차 생성자만 조회합니다. 본인은 제외할 수 없고 모임 생성자는 다른 참여자와 같은 조건으로 검사합니다. 결제자 겸 부담자·SELECTED 또는 CUSTOM 부담자·최소 인원 위반을 확인하고 관련 지출 전체를 반환합니다. 이 검사는 데이터를 변경하지 않습니다.',
    tags: ['정산'],
  })
  @ApiDataResponse(ExclusionCheck)
  @ApiErrors()
  @ApiParam({
    name: 'roundId',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiParam({
    name: 'userId',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  checkExclusion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('roundId') roundId: string,
    @Param('userId') userId: string,
  ) {
    return this.service.checkExclusion(user, roundId, userId);
  }

  @JsonBody()
  @Post('api/rounds/:roundId/members/:userId/exclude')
  @HttpCode(200)
  @ApiOperation({
    summary: '회차 사용자 제외와 ALL 재분배',
    description:
      'AUTH → 회차·대상 통합 조회 → 조건부 단일 제외 저장의 SQL 3회이며 명시적 트랜잭션·락은 없습니다. 같은 키/새 키 재요청에서 이미 제외됐거나 대상 참여 이력이 없으면 404입니다. 회차 생성자만 기록 단계에서 제외 조건을 다시 검사합니다. 본인은 제외할 수 없고 모임 생성자는 다른 참여자와 같은 조건으로 제외할 수 있습니다. 차단 시 해당 사용자와 연관된 정산이 있습니다. 메시지와 관련 내역을 반환하며 아무것도 변경하지 않습니다. 성공 시 round_members.excluded_at과 해당 회차의 ALL 분배만 수정합니다. group_members.left_at, 다른 회차, 다음 회차 후보와 비부담 결제자 수취 관계는 보존합니다.',
    tags: ['정산'],
  })
  @ApiDataResponse(MutationResult)
  @ApiErrors()
  @ApiMutationHeaders()
  @ApiParam({
    name: 'roundId',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiParam({
    name: 'userId',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  async excludeMember(
    @CurrentUser() user: AuthenticatedUser,
    @RequiredIdempotencyKey() idempotencyKey: string,
    @Body() body: VersionRequestDTO,
    @Param('roundId') roundId: string,
    @Param('userId') userId: string,
  ) {
    let audience: RoundAudience | null = null;
    const result = await this.service.excludeMember(
      user,
      idempotencyKey,
      roundId,
      userId,
      body,
      (value) => {
        audience = value;
      },
    );
    if (this.publisher.realtimeEnabled())
      after(() =>
        this.publisher.publishRoundInvalidation(roundId, audience, false),
      );
    return result;
  }

  @ApiConsumes('multipart/form-data')
  @UseInterceptors(ReceiptUploadInterceptor)
  @Post('api/rounds/:roundId/expenses/:expenseId/receipts')
  @HttpCode(202)
  @ApiOperation({
    summary: '영수증 증빙 이미지 업로드',
    description:
      '기록 단계에서 제외되지 않은 지출 원작성자 또는 해당 회차 생성자가 이미 저장된 지출에 파일 하나를 별도로 업로드합니다. AUTH 회원 조회와 파일 수신 전 리소스 권한·재시도 접수 확인 후 파일 크기·확장자·MIME·실제 AV1 코덱을 검증합니다. 단일 SQL에서 권한·상태·버전을 검사하여 PENDING 영수증·회차 버전·멱등 결과와 DB 영속 큐를 함께 저장하고 202로 응답합니다. 워커는 MinIO PUT 뒤 단일 SQL로 객체 키와 READY 상태를 기록합니다. 정상 신규 업로드의 업무 SQL은 AUTH·접수 확인·원자적 저장 3회, 워커의 저장 SQL은 1회이며 큐 제어 SQL은 별도입니다. 업로드 실패는 지출 원본을 삭제하지 않으며 목록 응답에는 바이트 본문이 없습니다.',
    tags: ['지출'],
  })
  @ApiDataResponse(
    MutationResult,
    '영속 큐 접수 완료. 파일 저장 완료는 storageStatus=READY로 확인합니다.',
    202,
  )
  @ApiErrors([400, 401, 403, 404, 409, 413, 415, 422, 424, 429, 503])
  @ApiMutationHeaders()
  @ApiParam({
    name: 'roundId',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiParam({
    name: 'expenseId',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  async addReceipt(
    @CurrentReceiptAdmission() admission: ReceiptAdmission,
    @UploadedFile() file: ReceiptFile,
    @Body() body: ReceiptUploadRequestDTO,
  ) {
    let audience: RoundAudience | null = null;
    const result = await this.service.saveReceipt(
      admission,
      {
        expectedVersion: body.expectedVersion,
        bytes: file.buffer,
        type: file.mimetype,
        name: file.originalname,
      },
      (value) => {
        audience = value;
      },
    );
    if (this.publisher.realtimeEnabled())
      after(() =>
        this.publisher.publishRoundInvalidation(
          admission.roundId,
          audience,
          false,
        ),
      );
    return result;
  }

  @JsonBody()
  @Delete('api/rounds/:roundId/expenses/:expenseId/receipts/:receiptId')
  @HttpCode(200)
  @ApiOperation({
    summary: '영수증 증빙 삭제',
    description:
      '기록 단계에서 제외되지 않은 지출 원작성자 또는 해당 회차 생성자만 증빙을 삭제합니다. AUTH 회원 조회 → 권한·상태·버전·재시도 통합 조회 → 영수증 삭제·회차 버전·성공 기록 단일 SQL의 총 3회이며 명시적 트랜잭션·advisory lock은 없습니다. 저장 SQL에서 현재 조건을 다시 검사하며 DB 자동 커밋 후 MinIO 객체를 삭제합니다. 같은 키·본문의 성공 재생은 SQL 2회로 기존 결과를 반환하고 객체 삭제·알림을 반복하지 않습니다.',
    tags: ['지출'],
  })
  @ApiDataResponse(MutationResult)
  @ApiErrors()
  @ApiMutationHeaders()
  @ApiParam({
    name: 'roundId',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiParam({
    name: 'expenseId',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiParam({
    name: 'receiptId',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  async removeReceipt(
    @CurrentUser() user: AuthenticatedUser,
    @RequiredIdempotencyKey() idempotencyKey: string,
    @Body() body: VersionRequestDTO,
    @Param('roundId') roundId: string,
    @Param('expenseId') expenseId: string,
    @Param('receiptId') receiptId: string,
  ) {
    let audience: RoundAudience | null = null;
    const result = await this.service.removeReceipt(
      user,
      idempotencyKey,
      roundId,
      expenseId,
      receiptId,
      body,
      (value) => {
        audience = value;
      },
    );
    if (this.publisher.realtimeEnabled())
      after(() =>
        this.publisher.publishRoundInvalidation(roundId, audience, false),
      );
    return result;
  }

  @Get('api/receipts/:receiptId')
  @RawApiResponse()
  @ApiOperation({
    summary: '참여 이력 검증 후 영수증 이미지 조회',
    description:
      'Node JWT Guard에서 입력 검사 전에 JWT를 검증하고, DB에서 회원 상태 및 리소스 권한을 검증하며 세션 유효성은 조회하지 않습니다. 응답은 private, no-store입니다.',
    tags: ['지출'],
  })
  @ApiResponse({
    status: 200,
    description:
      '신규 업로드는 AVIF, 기존 자료는 저장된 JPEG·PNG·WebP로 응답합니다. private, no-store 및 nosniff 헤더를 적용합니다.',
    content: {
      'image/avif': { schema: { type: 'string', format: 'binary' } },
      'image/jpeg': { schema: { type: 'string', format: 'binary' } },
      'image/png': { schema: { type: 'string', format: 'binary' } },
      'image/webp': { schema: { type: 'string', format: 'binary' } },
    },
  })
  @ApiErrors([401, 404, 409, 429, 503])
  @ApiParam({
    name: 'receiptId',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  async getReceipt(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: ServerResponse,
    @Param('receiptId') receiptId: string,
  ) {
    const receipt = await this.service.getReceipt(user, receiptId);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'private, no-store');
    return new StreamableFile(receipt.content, { type: receipt.mimeType });
  }
}
