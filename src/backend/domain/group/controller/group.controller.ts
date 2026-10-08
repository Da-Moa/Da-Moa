import { JsonBody } from '../../../global/apiPayload/requestBody.interceptor';
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
@Controller()
export class GroupController {
  constructor(
    @Inject(GroupService) private readonly service: GroupService,
    @Inject(RealtimePublisher) private readonly publisher: RealtimePublisher,
  ) {}

  @Get('api/groups')
  listGroups(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: GroupListQueryDTO,
  ) {
    return this.service.listGroups(user, query);
  }

  @JsonBody()
  @Post('api/groups')
  @HttpCode(200)
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
  getGroup(
    @CurrentUser() user: AuthenticatedUser,
    @Param('groupId') groupId: string,
  ) {
    return this.service.getGroup(user, groupId);
  }

  @Delete('api/groups/:groupId')
  @HttpCode(200)
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
  getInvite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('token') token: string,
  ) {
    return this.service.getInvite(user, token);
  }

  @Post('api/invites/:token/accept')
  @HttpCode(200)
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
