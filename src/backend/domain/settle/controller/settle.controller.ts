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
  Req,
  Res,
  Param,
} from '@nestjs/common';
import type { Request, Response as ServerResponse } from 'express';
import {
  webRequest,
  after,
  type HttpRequest,
} from '../../../global/apiPayload/httpContext';
import { CurrentUser, type AuthenticatedUser } from '../../../global/auth';
import { SettleService } from '../service/settle.service';
import {
  CreateRoundRequestDTO,
  RoundListQueryDTO,
  parseRoundListQuery,
  ExpenseRequestDTO,
  CreateExpenseRequestDTO,
  SettlementCheckRequestDTO,
  VersionRequestDTO,
} from '../dto/req/settle.request.dto';
import { settleSuccess } from '../code/settle.success.code';
import {
  ApiSuccess,
  RawApiResponse,
} from '../../../global/apiPayload/apiResponse.interceptor';
import { settleErrors } from '../code/settle.error.code';
import { SettleException } from '../exception/settle.exception';
import { RealtimePublisher, type RoundAudience } from '../../../global/util';
import { readBytes } from '../../../global/util';
import { MAX_RECEIPT_REQUEST_BYTES } from '../../../../shared/domain/settle';
@ApiSuccess(settleSuccess)
@Controller()
export class SettleController {
  constructor(
    @Inject(SettleService) private readonly service: SettleService,
    @Inject(RealtimePublisher) private readonly publisher: RealtimePublisher,
  ) {}

  @Get('api/groups/:groupId/rounds')
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
  listRounds(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: RoundListQueryDTO,
  ) {
    return this.service.listRounds(user, parseRoundListQuery(query));
  }

  @Get('api/rounds/:roundId')
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
  getSettlement(
    @CurrentUser() user: AuthenticatedUser,
    @Param('roundId') roundId: string,
  ) {
    return this.service.getSettlement(user, roundId);
  }

  @JsonBody()
  @Post('api/rounds/:roundId/settlement-check')
  @HttpCode(200)
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

  @Post('api/rounds/:roundId/expenses/:expenseId/receipts')
  @HttpCode(202)
  async addReceipt(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
    @RequiredIdempotencyKey() idempotencyKey: string,
    @Param('roundId') roundId: string,
    @Param('expenseId') expenseId: string,
  ) {
    const web = webRequest(request);
    let audience: RoundAudience | null = null;
    const result = await this.service.addReceipt(
      user,
      idempotencyKey,
      roundId,
      expenseId,
      () => this.receiptForm(web),
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
  @Delete('api/rounds/:roundId/expenses/:expenseId/receipts/:receiptId')
  @HttpCode(200)
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
  private async receiptForm(web: HttpRequest) {
    const bytes = await readBytes(
      web,
      MAX_RECEIPT_REQUEST_BYTES,
      'receipt_too_large',
    );
    let form: FormData;
    try {
      form = await new Response(bytes.buffer, {
        headers: web.headers,
      }).formData();
    } catch {
      throw new SettleException(settleErrors.INVALID_RECEIPT_FORM);
    }
    const file = form.get('file');
    if (
      !(file instanceof File) ||
      form.getAll('file').length !== 1 ||
      form.getAll('expectedVersion').length !== 1 ||
      [...form.keys()].some(
        (field) => !['file', 'expectedVersion'].includes(field),
      )
    )
      throw new SettleException(settleErrors.SINGLE_RECEIPT_REQUIRED);
    return {
      expectedVersion: Number(form.get('expectedVersion')),
      bytes: new Uint8Array(await file.arrayBuffer()),
      type: file.type,
      name: file.name,
    };
  }
}
