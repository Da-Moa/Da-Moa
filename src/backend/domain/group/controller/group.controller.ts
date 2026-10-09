import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiDataResponse,
  ApiErrors,
  ApiMutationHeaders,
} from '../../../global/apiPayload/documentation.decorator';
import {
  GroupPage,
  GroupSummary,
  GroupMutationResult,
  GroupDetail,
  InvitePreview,
} from '../dto/res/group.response.dto';
import { JsonBody } from '../../../global/apiPayload/requestBody.interceptor';
import { parseSearchPageQuery } from '../../../global/apiPayload/pageQuery';
import { groupErrors } from '../code/group.error.code';
import { RequiredIdempotencyKey } from '../../../global/apiPayload/requiredHeader.decorator';
import {
  Controller,
  Body,
  Query,
  HttpCode,
  Get,
  Post,
  Delete,
  Inject,
  Param,
} from '@nestjs/common';
import { after } from '../../../global/apiPayload/httpContext';
import { CurrentUser, type AuthenticatedUser } from '../../../global/auth';
import { GroupService } from '../service/group.service';
import {
  CreateGroupRequestDTO,
  CreateInviteRequestDTO,
  GroupListQueryDTO,
} from '../dto/req/group.request.dto';
import { groupSuccess } from '../code/group.success.code';
import { ApiSuccess } from '../../../global/apiPayload/apiResponse.interceptor';
import { RealtimePublisher } from '../../../global/util/invalidationUtil';
@ApiSuccess(groupSuccess)
@ApiExtraModels(GroupSummary)
@ApiBearerAuth('accessBearer')
@ApiTags('모임')
@Controller()
export class GroupController {
  constructor(
    @Inject(GroupService) private readonly service: GroupService,
    @Inject(RealtimePublisher) private readonly publisher: RealtimePublisher,
  ) {}

  @Get('api/groups')
  @ApiQuery({
    name: 'q',
    required: false,
    description: '모임명의 대소문자를 구분하지 않는 부분 검색어',
  })
  @ApiOperation({
    summary: '활성 모임 목록',
    description:
      'Node JWT Guard를 먼저 통과한 뒤 트랜잭션 없이 AUTH 회원 조회 → 모임·활성 멤버 ID 조회 → Set으로 중복 제거한 회원 프로필 조회, 총 SQL 3회입니다. 모임 ID 내림차순으로 limit+1개를 먼저 선택한 뒤 멤버를 집계합니다. q는 제목 ILIKE 부분 검색이며 %, _, 역슬래시는 문자 그대로 찾습니다. 빈 목록은 프로필 조회를 생략해 2회입니다.',
    tags: ['모임'],
  })
  @ApiDataResponse(GroupPage)
  @ApiErrors()
  @ApiQuery({
    name: 'cursor',
    required: false,
    description:
      '모임 ID 내림차순 서버 발급 커서. 조회에는 id만 사용하며 기존 커서 형식의 createdAt은 호환을 위해 유지합니다.',
  })
  listGroups(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: GroupListQueryDTO,
  ) {
    return this.service.listGroups(user, parseSearchPageQuery(query));
  }

  @JsonBody()
  @Post('api/groups')
  @HttpCode(200)
  @ApiOperation({
    summary: '모임 생성',
    description:
      'JWT·회원 상태를 확인한 뒤 UUIDv7 Idempotency-Key를 모임 PK로 사용합니다. 명시적 트랜잭션 없이 모임·생성자 멤버십을 한 SQL로 저장하고 총 AUTH+생성 2회입니다. 같은 PK는 409 group_already_exists로 거절하며 멱등 기록 조회·저장은 하지 않습니다.',
    tags: ['모임'],
  })
  @ApiDataResponse(GroupMutationResult)
  @ApiErrors()
  @ApiMutationHeaders(
    '모임 PK로 사용할 UUIDv7. 같은 키 재전송은 409로 거절합니다.',
  )
  async createGroup(
    @CurrentUser() user: AuthenticatedUser,
    @RequiredIdempotencyKey(groupErrors.GROUP_CREATION_KEY_REQUIRED)
    idempotencyKey: string,
    @Body() body: CreateGroupRequestDTO,
  ) {
    let audience: string[] | undefined;
    const result = await this.service.createGroup(
      user,
      idempotencyKey,
      body,
      (ids) => {
        audience = ids;
      },
    );
    if (this.publisher.realtimeEnabled())
      after(() =>
        this.publisher.publishGroupInvalidation(result.id, audience, false),
      );
    return result;
  }

  @Get('api/groups/:groupId')
  @ApiOperation({
    summary: '모임 상세 정보',
    description:
      'JWT 회원 조회 1회 → 모임·활성 group_members·users를 JOIN하여 멤버 이름까지 조회하고 본인의 참여 여부 비교 1회 → 생성자인 경우에만 유효 초대 조회 1회입니다. 명시적 트랜잭션 없이 일반 멤버는 SQL 2회, 생성자는 3회이며 멤버 목록을 함께 반환하며 회차는 포함하지 않습니다. 초대 원문 링크는 최초 발급 응답에서만 제공합니다.',
    tags: ['모임'],
  })
  @ApiDataResponse(GroupDetail)
  @ApiErrors()
  @ApiParam({
    name: 'groupId',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  getGroup(
    @CurrentUser() user: AuthenticatedUser,
    @Param('groupId') groupId: string,
  ) {
    return this.service.getGroup(user, groupId);
  }

  @Delete('api/groups/:groupId')
  @HttpCode(200)
  @ApiOperation({
    summary: '모임 나가기 또는 없애기',
    description:
      '일반 참여자는 본인이 참여 중인 미종료 회차가 없을 때 현재 멤버십의 leftAt을 기록하고 나갑니다. 모임 생성자는 본인 참여 여부와 무관하게 모임 전체의 모든 회차가 종료된 경우에만 모든 멤버십을 종료하고 초대를 폐기합니다. 완료된 회차와 모임 이름은 과거 정산 조회를 위해 보존합니다.',
    tags: ['모임'],
  })
  @ApiDataResponse(GroupMutationResult)
  @ApiErrors()
  @ApiMutationHeaders()
  @ApiParam({
    name: 'groupId',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  async leaveGroup(
    @CurrentUser() user: AuthenticatedUser,
    @RequiredIdempotencyKey() idempotencyKey: string,
    @Param('groupId') groupId: string,
  ) {
    let audience: string[] | undefined;
    const result = await this.service.leaveGroup(
      user,
      idempotencyKey,
      groupId,
      (ids) => {
        audience = ids;
      },
    );
    if (this.publisher.realtimeEnabled())
      after(() =>
        this.publisher.publishGroupInvalidation(groupId, audience, false),
      );
    return result;
  }

  @JsonBody()
  @Post('api/groups/:groupId/invites')
  @HttpCode(200)
  @ApiOperation({
    summary: '7일 유효 초대 발급·재발급',
    description:
      '모임 생성자가 발급하며 원문 링크는 최초 응답에서만 제공합니다. 같은 키 재시도는 inviteId와 linkUnavailable을 반환합니다. 새 키와 replaceInviteId로 이전 초대를 폐기하며 다시 발급합니다.',
    tags: ['모임'],
  })
  @ApiDataResponse(GroupMutationResult)
  @ApiErrors()
  @ApiMutationHeaders()
  @ApiParam({
    name: 'groupId',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  async createInvite(
    @CurrentUser() user: AuthenticatedUser,
    @RequiredIdempotencyKey() idempotencyKey: string,
    @Body()
    body: CreateInviteRequestDTO,
    @Param('groupId') groupId: string,
  ) {
    let audience: string[] | undefined;
    const result = await this.service.createInvite(
      user,
      idempotencyKey,
      groupId,
      body,
      (ids) => {
        audience = ids;
      },
    );
    if (this.publisher.realtimeEnabled())
      after(() =>
        this.publisher.publishGroupInvalidation(groupId, audience, true),
      );
    return result;
  }

  @Delete('api/groups/:groupId/invites/:inviteId')
  @HttpCode(200)
  @ApiOperation({
    summary: '모임 생성자가 초대 폐기',
    description:
      'Node JWT Guard에서 입력 검사 전에 JWT를 검증하고, DB에서 회원 상태 및 리소스 권한을 검증하며 세션 유효성은 조회하지 않습니다. 응답은 private, no-store입니다.',
    tags: ['모임'],
  })
  @ApiDataResponse(GroupMutationResult)
  @ApiErrors()
  @ApiMutationHeaders()
  @ApiParam({
    name: 'groupId',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiParam({
    name: 'inviteId',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  async revokeInvite(
    @CurrentUser() user: AuthenticatedUser,
    @RequiredIdempotencyKey() idempotencyKey: string,
    @Param('groupId') groupId: string,
    @Param('inviteId') inviteId: string,
  ) {
    let audience: string[] | undefined;
    const result = await this.service.revokeInvite(
      user,
      idempotencyKey,
      groupId,
      inviteId,
      (ids) => {
        audience = ids;
      },
    );
    if (this.publisher.realtimeEnabled())
      after(() =>
        this.publisher.publishGroupInvalidation(groupId, audience, true),
      );
    return result;
  }

  @Get('api/invites/:token')
  @ApiOperation({
    summary: '인증 후 초대 모임 미리보기',
    description:
      '조회만으로 멤버십을 생성하지 않습니다. 만료·폐기되었거나 활성 모임 생성자가 없는 초대는 거부합니다.',
    tags: ['모임'],
  })
  @ApiDataResponse(InvitePreview)
  @ApiErrors()
  @ApiParam({ name: 'token', required: true, schema: { type: 'string' } })
  getInvite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('token') token: string,
  ) {
    return this.service.getInvite(user, token);
  }

  @Post('api/invites/:token/accept')
  @HttpCode(200)
  @ApiOperation({
    summary: '초대를 명시적으로 수락',
    description:
      'AUTH → 토큰 형식 검사 → 유효 초대/성공 기록 조회 → BEGIN → transaction advisory lock 획득 → 조건부 멤버십·성공 기록 단일 SQL → COMMIT의 정상 SQL 6회입니다. 같은 키의 성공 재생은 AUTH·기록 조회 2회이며 트랜잭션을 시작하지 않습니다. COMMIT 또는 ROLLBACK에서 락을 자동 해제합니다. 기존 쓰기와 같은 advisory lock으로 정원을 보호하며 삽입 시 회원·초대·생성자·현재 정원을 다시 확인합니다. 새 키의 활성 멤버 중복 수락·동시 삽입 충돌은 409 group_already_member, 정원 초과는 409 group_member_limit_exceeded입니다. 이미 성공한 같은 키는 기존 결과를 반환합니다. 이탈자는 재참여할 수 있으며 기존 회차에는 자동 추가되지 않습니다.',
    tags: ['모임'],
  })
  @ApiDataResponse(GroupMutationResult)
  @ApiErrors()
  @ApiMutationHeaders()
  @ApiParam({ name: 'token', required: true, schema: { type: 'string' } })
  async acceptInvite(
    @CurrentUser() user: AuthenticatedUser,
    @RequiredIdempotencyKey() idempotencyKey: string,
    @Param('token') token: string,
  ) {
    let audience: string[] | undefined;
    const result = await this.service.acceptInvite(
      user,
      idempotencyKey,
      token,
      (ids) => {
        audience = ids;
      },
    );
    if (this.publisher.realtimeEnabled())
      after(() =>
        this.publisher.publishGroupInvalidation(result.id, audience, false),
      );
    return result;
  }
}
