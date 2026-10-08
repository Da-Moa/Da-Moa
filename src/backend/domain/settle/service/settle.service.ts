import { ReceiptStorage } from '../../../global/util/minio.util';
import { MutationExecutor } from '../../../global/util/idempotencyUtil';
import type { RoundListQueryDTO } from '../dto/req/settle.request.dto';
import type { PageQueryDTO } from '../../../global/apiPayload/dto/req/page.request.dto';
import { Injectable, Inject } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { PrismaService } from '../../../global/database/prisma.service';
import { settleErrors } from '../code/settle.error.code';
import { SettleException } from '../exception/settle.exception';
import { randomInt, randomUUID } from 'node:crypto';
import { AuthorizationService } from '../../../global/auth/service/authorization.service';
import { MAX_GROUP_MEMBERS } from '../../../../shared/domain/group';
import { bankDisplayName } from '../../../../shared/domain/user';
import {
  AppError,
  badInput,
  mutationDigest,
  mutationResult,
  type Database,
  idsInput,
  nowSeconds,
  onlyKeys,
  pageOf,
  pagination,
  queryParameters,
  textInput,
  type Identity,
} from '../../../global/util';
import { validateReceipt } from './receiptFile';
import {
  MAX_ROUND_CURRENCIES,
  formatMoney,
  MAX_EXPENSE_MAJOR,
  MAX_ROUND_TOTAL_MAJOR,
  minorLimit,
  parseAmount,
  requireCurrency,
  type Currency,
  type CreateRoundRequestDTO,
  type ExpenseRequestDTO,
  type VersionRequestDTO,
  type SettlementCheckRequestDTO,
} from '../../../../shared/domain/settle';
import {
  calculateBase,
  finalizeCurrencySettlement,
  previewCurrencySettlement,
  validateCustomShares,
} from '../../../../shared/domain/settle';
import type {
  ExclusionCheck,
  Expense,
  MutationResult,
  RoundDetail,
  RoundMember,
  RoundStatus,
  RoundSummary,
  SettlementDTO,
  SettlementTransfer,
} from '../../../../shared/domain/settle';

import type {
  RoundRow,
  RoundConfirmationRow,
  MemberRow,
  ExpenseRow,
  ShareRow,
  ReceiptRow,
  SettlementExpenseRow,
  ExpenseUpdateRow,
  ExpenseDeletionRow,
  MemberExclusionRow,
} from '../dao/settle.dao';
import { duplicateRound, missing } from '../exception/settle.exception';
import { SettleRepository } from '../repository/settle.repository';

type ReceiptUpload = {
  expectedVersion: number;
  bytes: Uint8Array;
  type: string;
  name?: string;
};
type ReceiptAudience = (audience: {
  groupId: string;
  userIds: string[];
}) => void;

@Injectable()
export class SettleService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(SettleRepository)
    private readonly repository: SettleRepository,
    @Inject(AuthorizationService)
    private readonly authorization: AuthorizationService,
    @Inject(MutationExecutor) private readonly mutations: MutationExecutor,
    @Inject(ReceiptStorage) private readonly storage: ReceiptStorage,
  ) {}

  private async roundFor(
    client: Database,
    id: string,
    userId: string,
  ): Promise<RoundRow> {
    const { rows } = await this.repository.findRound(client, id, userId);
    if (!rows[0]) throw missing();
    return rows[0];
  }

  private creator(round: RoundRow) {
    if (!round.is_creator) throw new SettleException(settleErrors.CREATOR_ONLY);
  }

  private state(round: RoundRow, expected: RoundStatus) {
    if (
      round.status !== expected ||
      (expected !== 'COMPLETED' && round.completed_at !== null)
    ) {
      throw new SettleException(settleErrors.INVALID_ROUND_STATE);
    }
  }

  private version(round: RoundRow, value: unknown) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
      throw new SettleException(settleErrors.VERSION_REQUIRED);
    if (round.version !== value)
      throw new SettleException(settleErrors.STALE_ROUND, {
        version: round.version,
      });
  }

  private async bump(
    client: Database,
    id: string,
    expectedVersion: number,
  ): Promise<MutationResult> {
    const saved = await this.repository.bumpRound(client, id, expectedVersion);
    if (!saved) throw new SettleException(settleErrors.STALE_ROUND);
    return { ...saved, roundId: id };
  }

  private memberDetails(row: MemberRow): RoundMember {
    return {
      userId: row.user_id,
      displayName: row.display_name_snapshot,
      profileImageUrl: row.profile_image_url,
      excludedAt: row.excluded_at === null ? null : Number(row.excluded_at),
    };
  }

  private async membersFor(
    client: Database,
    roundId: string,
  ): Promise<RoundMember[]> {
    const { rows } = await this.repository.findMembers(client, roundId);
    return rows.map(this.memberDetails);
  }

  private expenseDetails(
    row: ExpenseRow,
    part: Omit<ShareRow, 'expense_id'>[],
    receipts: Pick<
      ReceiptRow,
      'id' | 'mime_type' | 'byte_size' | 'storage_status'
    >[],
  ): Expense {
    const base =
      row.split_mode === 'CUSTOM'
        ? null
        : calculateBase(BigInt(row.amount_minor), part.length);
    return {
      id: row.id,
      authorId: row.author_id,
      payerId: row.payer_id,
      description: row.description,
      currency: row.currency,
      amountMinor: row.amount_minor,
      splitMode: row.split_mode,
      participantIds: part.map((s) => s.user_id),
      baseShareMinor: base
        ? (row.base_share_minor ?? base.base.toString())
        : null,
      remainderUnits: base ? (row.remainder_units ?? base.remainder) : 0,
      shares: part.map((s) => ({
        userId: s.user_id,
        assignedAmountMinor: s.assigned_amount_minor,
        amountMinor: s.final_amount_minor,
        receivedRemainder: s.received_remainder,
      })),
      receipts: receipts.map((r) => ({
        id: r.id,
        mimeType: r.mime_type,
        byteSize: r.byte_size,
        storageStatus: r.storage_status,
      })),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private async settlementExpensesFor(
    client: Database,
    roundId: string,
  ): Promise<
    (Pick<
      Expense,
      | 'id'
      | 'payerId'
      | 'amountMinor'
      | 'splitMode'
      | 'currency'
      | 'participantIds'
    > & {
      shares: Pick<
        Expense['shares'][number],
        'userId' | 'assignedAmountMinor'
      >[];
    })[]
  > {
    const { rows } = await this.repository.findSettlementExpenses(
      client,
      roundId,
    );
    return rows.map(this.settlementExpenseDetails);
  }

  private settlementExpenseDetails(row: SettlementExpenseRow) {
    return {
      id: row.id,
      payerId: row.payer_id,
      currency: row.currency,
      amountMinor: row.amount_minor,
      splitMode: row.split_mode,
      participantIds: row.participant_ids,
      shares: row.shares ?? [],
    };
  }

  private summary(row: RoundRow): RoundSummary {
    return {
      id: row.id,
      groupId: row.group_id,
      groupName: row.group_name,
      name: row.name,
      status: row.status,
      version: row.version,
      createdAt: Number(row.created_at),
      finalizedAt: row.finalized_at === null ? null : Number(row.finalized_at),
      completedAt: row.completed_at === null ? null : Number(row.completed_at),
      totals: row.totals ?? [],
      memberCount: Number(row.member_count ?? 0),
    };
  }

  async listRounds(
    access: Identity,
    query: URLSearchParams | RoundListQueryDTO,
    groupId?: string,
  ) {
    query = queryParameters(query);
    return this.prisma.withDatabaseConnection(async (client) => {
      const account = await this.authorization.requireAccount(client, access);
      const { limit, cursor } = pagination(query);
      const status = query.get('status');
      const search = query.has('q') ? textInput(query.get('q'), 100) : null;
      if (
        status &&
        !['active', 'RECORDING', 'CONFIRMED', 'LOCKED', 'COMPLETED'].includes(
          status,
        )
      )
        badInput();
      const { rows } = await this.repository.findRounds(
        client,
        account.id,
        groupId ?? null,
        status,
        search,
        cursor?.createdAt ?? null,
        cursor?.id ?? null,
        limit + 1,
      );
      return pageOf(rows.map(this.summary), limit, (row) => row);
    });
  }

  async getRound(
    access: Identity,
    roundId: string,
    query: URLSearchParams | PageQueryDTO,
  ): Promise<RoundDetail> {
    query = queryParameters(query);
    return this.prisma.withDatabaseConnection(async (client) => {
      const account = await this.authorization.requireAccount(client, access);
      const { limit, cursor } = pagination(query);
      const { rows } = await this.repository.findRoundDetail(
        client,
        roundId,
        account.id,
        cursor?.createdAt ?? null,
        cursor?.id ?? null,
        limit + 1,
      );
      const round = rows[0];
      if (!round) throw missing();
      const members = round.members.map(this.memberDetails);
      const expenses = pageOf(
        round.expenses.map((row) =>
          this.expenseDetails(row, row.shares, row.receipts),
        ),
        limit,
        (row) => row,
      );
      let transfers: SettlementTransfer[] = [],
        pendingRemainders: RoundDetail['pendingRemainders'] = [];
      if (round.finalized_at === null) {
        const allExpenses = round.settlement_expenses.map(
          this.settlementExpenseDetails,
        );
        if (allExpenses.length)
          ({ transfers, pendingRemainders } = previewCurrencySettlement(
            allExpenses,
            members.map((member) => member.userId),
          ));
      } else {
        transfers = round.transfers.map((row) => ({
          currency: row.currency,
          senderId: row.sender_id,
          receiverId: row.receiver_id,
          amountMinor: row.amount_minor,
        }));
      }
      transfers = transfers.filter(
        (transfer) =>
          transfer.senderId === account.id ||
          transfer.receiverId === account.id,
      );
      return {
        ...this.summary({
          ...round,
          member_count: members.filter((m) => m.excludedAt === null).length,
        }),
        creatorId: round.creator_id,
        groupCreatorId: round.group_creator_id,
        isCreator: round.is_creator,
        members,
        expenses: expenses.items,
        expensesNextCursor: expenses.nextCursor,
        transfers,
        pendingRemainders,
      };
    });
  }

  async createRound(
    access: Identity,
    key: string,
    groupId: string,
    body: CreateRoundRequestDTO | Record<string, unknown>,
    captureAudience?: (userIds: string[]) => void,
  ) {
    return this.prisma.withDatabaseConnection((client, discardConnection) =>
      this.prisma.withWriteLock(client, discardConnection, async (client) => {
        const account = await this.authorization.requireAccount(client, access);
        onlyKeys(body, ['name', 'participantIds']);
        const name = textInput(body.name, 100),
          ids = idsInput(body.participantIds);
        if (!isUUID(key, '7'))
          throw new SettleException(settleErrors.ROUND_CREATION_KEY_REQUIRED);
        if (ids.length < 2 || !ids.includes(account.id))
          throw new SettleException(settleErrors.MINIMUM_PARTICIPANTS);
        const id = key.toLowerCase();
        try {
          const result = await this.repository.insertRound(
            client,
            id,
            groupId,
            account.id,
            name,
            nowSeconds(),
            ids,
          );
          if (!result.actor_active)
            throw new SettleException(settleErrors.UNAUTHORIZED);
          if (!result.is_member) throw missing();
          if (!result.created)
            throw new SettleException(settleErrors.GROUP_MEMBERS_REQUIRED);
        } catch (error) {
          if (
            error &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === '23505' &&
            'constraint' in error &&
            error.constraint === 'rounds_pkey'
          )
            throw duplicateRound();
          throw error;
        }
        captureAudience?.(ids);
        return { id, roundId: id, status: 'RECORDING' as const, version: 1 };
      }),
    );
  }

  private expenseFields(
    body: ExpenseRequestDTO | Record<string, unknown>,
    previous?: ExpenseRow,
  ): {
    currency: Currency;
    description: string;
    amount: string;
    payerId: string;
    splitMode: Expense['splitMode'];
  } {
    onlyKeys(body, [
      'currency',
      'description',
      'amount',
      'payerId',
      'splitMode',
      'participantIds',
      'customShares',
      'expectedVersion',
    ]);
    let currency: Currency;
    try {
      currency = requireCurrency(
        body.currency === undefined ? previous?.currency : body.currency,
      );
    } catch {
      throw new SettleException(settleErrors.UNSUPPORTED_EXPENSE_CURRENCY);
    }
    if (previous && currency !== previous.currency && body.amount === undefined)
      throw new SettleException(settleErrors.CURRENCY_CHANGE_REQUIRES_AMOUNT);
    if (
      previous?.split_mode === 'CUSTOM' &&
      (body.splitMode ?? previous.split_mode) === 'CUSTOM' &&
      currency !== previous.currency &&
      body.customShares === undefined
    )
      throw new SettleException(
        settleErrors.CURRENCY_CHANGE_REQUIRES_CUSTOM_SHARES,
      );
    const description = textInput(
      body.description === undefined ? previous?.description : body.description,
      500,
    );
    let amount: bigint;
    try {
      amount =
        body.amount === undefined && previous
          ? BigInt(previous.amount_minor)
          : parseAmount(body.amount, currency);
    } catch {
      throw new SettleException(settleErrors.INVALID_AMOUNT);
    }
    const maximum = minorLimit(MAX_EXPENSE_MAJOR, currency);
    if (amount > maximum)
      throw new SettleException({
        ...settleErrors.EXPENSE_AMOUNT_LIMIT_EXCEEDED,
        message: `지출 금액은 ${formatMoney(maximum.toString(), currency)} 이하여야 해요`,
      });
    const payerId = textInput(
      body.payerId === undefined ? previous?.payer_id : body.payerId,
      128,
    );
    const splitMode =
      body.splitMode === undefined ? previous?.split_mode : body.splitMode;
    if (
      splitMode !== 'ALL' &&
      splitMode !== 'SELECTED' &&
      splitMode !== 'CUSTOM'
    )
      throw new SettleException(settleErrors.INVALID_SPLIT_MODE);
    if (splitMode !== 'CUSTOM' && body.customShares !== undefined)
      throw new SettleException(settleErrors.CUSTOM_SHARES_REQUIRE_CUSTOM_MODE);
    return {
      currency,
      description,
      amount: amount.toString(),
      payerId,
      splitMode,
    };
  }

  private customSharesInput(value: unknown, currency: Currency) {
    if (
      !Array.isArray(value) ||
      !value.length ||
      value.length > MAX_GROUP_MEMBERS
    )
      throw new SettleException(settleErrors.CUSTOM_SHARES_REQUIRED);
    return value.map((share) => {
      if (!share || typeof share !== 'object' || Array.isArray(share))
        throw new SettleException(settleErrors.CUSTOM_SHARES_REQUIRED);
      onlyKeys(share, ['userId', 'amount']);
      let assignedAmount: bigint;
      try {
        assignedAmount = parseAmount(share.amount, currency);
      } catch {
        throw new SettleException(settleErrors.INVALID_CUSTOM_SHARE_AMOUNT);
      }
      return {
        userId: share.userId as string,
        assignedAmountMinor: assignedAmount.toString(),
      };
    });
  }

  private expenseInput(
    round: ExpenseUpdateRow,
    body: ExpenseRequestDTO | Record<string, unknown>,
    previous: ExpenseRow,
  ) {
    const input = this.expenseFields(body, previous);
    const { payerId, splitMode } = input;
    const active = round.active_ids;
    if (!active.includes(payerId) && payerId !== previous?.payer_id)
      throw new SettleException(settleErrors.PAYER_NOT_PARTICIPATING);
    let participantIds: string[];
    let assignedShares: {
      userId: string;
      assignedAmountMinor: string | null;
    }[] = [];
    if (splitMode === 'ALL') {
      if (body.participantIds !== undefined)
        throw new SettleException(
          settleErrors.ALL_PARTICIPANTS_ARE_SERVER_SELECTED,
        );
      participantIds = active;
    } else if (splitMode === 'CUSTOM') {
      if (body.participantIds !== undefined)
        throw new SettleException(
          settleErrors.CUSTOM_PARTICIPANTS_REQUIRE_SHARES,
        );
      if (
        body.customShares === undefined &&
        previous?.split_mode === 'CUSTOM'
      ) {
        assignedShares = round.shares.map((share) => ({
          userId: share.user_id,
          assignedAmountMinor: share.assigned_amount_minor,
        }));
      } else {
        assignedShares = this.customSharesInput(
          body.customShares,
          input.currency,
        );
      }
      participantIds = idsInput(assignedShares.map((share) => share.userId));
      if (participantIds.some((id) => !active.includes(id)))
        throw new SettleException(settleErrors.INACTIVE_SHARE_PARTICIPANT);
      this.checkCustomShares(
        BigInt(input.amount),
        participantIds,
        assignedShares,
      );
    } else {
      participantIds = idsInput(
        body.participantIds === undefined
          ? round.shares.map((s) => s.user_id)
          : body.participantIds,
      );
      if (participantIds.some((id) => !active.includes(id)))
        throw new SettleException(settleErrors.INACTIVE_SHARE_PARTICIPANT);
    }
    if (!participantIds.length)
      throw new SettleException(settleErrors.PARTICIPANTS_REQUIRED);
    return { ...input, participantIds, assignedShares };
  }

  private validateCurrencyTotals(
    totals: RoundSummary['totals'],
    input: { currency: Currency; amount: string },
    previous?: ExpenseRow,
  ) {
    const next = new Map(
      totals.map((total) => [total.currency, BigInt(total.totalMinor)]),
    );
    if (previous)
      next.set(
        previous.currency,
        (next.get(previous.currency) ?? 0n) - BigInt(previous.amount_minor),
      );
    next.set(
      input.currency,
      (next.get(input.currency) ?? 0n) + BigInt(input.amount),
    );
    if (
      [...next.values()].filter((amount) => amount > 0n).length >
      MAX_ROUND_CURRENCIES
    )
      throw new SettleException(settleErrors.CURRENCY_LIMIT_EXCEEDED);
    const maximum = minorLimit(MAX_ROUND_TOTAL_MAJOR, input.currency);
    if (next.get(input.currency)! > maximum)
      throw new SettleException({
        ...settleErrors.ROUND_TOTAL_LIMIT_EXCEEDED,
        message: `통화별 전체 지출은 ${formatMoney(maximum.toString(), input.currency)} 이하여야 해요`,
      });
  }

  private checkCustomShares(
    amount: bigint,
    participantIds: string[],
    shares: { userId: string; assignedAmountMinor: string | null }[],
  ) {
    try {
      validateCustomShares(amount, participantIds, shares);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'invalid_amount';
      badInput(
        code,
        code === 'custom_share_total_mismatch'
          ? '부담금 합계가 총 금액과 일치해야 해요'
          : '개별 부담자와 부담금을 다시 확인해 주세요',
      );
    }
  }

  private async createExpense(
    access: Identity,
    key: string,
    roundId: string,
    body: ExpenseRequestDTO | Record<string, unknown>,
    captureAudience?: (audience: {
      groupId: string;
      userIds: string[];
    }) => void,
  ) {
    let userId: string,
      digest: string,
      input: ReturnType<SettleService['expenseFields']>;
    let participantIds: string[] = [],
      assignedShares: ReturnType<SettleService['customSharesInput']> = [];
    return this.prisma.withWriteTransaction(
      async (client) => {
        const id = randomUUID(),
          now = nowSeconds();
        const round = await this.repository.insertExpenseCreation(
          client,
          id,
          roundId,
          userId,
          key,
          { ...input, participantIds },
          body.expectedVersion as number,
          minorLimit(MAX_ROUND_TOTAL_MAJOR, input.currency).toString(),
          now,
        );
        if (!round.actor_active)
          throw new SettleException(settleErrors.UNAUTHORIZED);
        const replay = mutationResult<MutationResult>(round, digest);
        if (replay) return replay;
        if (!round.id) throw missing();
        this.state(round, 'RECORDING');
        if (!round.is_creator && !round.active_ids.includes(userId))
          throw new SettleException(settleErrors.EXPENSE_EDITOR_ONLY);
        this.version(round, body.expectedVersion);
        const actual = input;
        if (!round.active_ids.includes(actual.payerId))
          throw new SettleException(settleErrors.PAYER_NOT_PARTICIPATING);
        if (actual.splitMode === 'ALL') participantIds = round.active_ids;
        if (
          !participantIds.length ||
          participantIds.some((id) => !round.active_ids.includes(id))
        )
          throw new SettleException(settleErrors.INACTIVE_SHARE_PARTICIPANT);
        if (actual.splitMode === 'CUSTOM')
          assignedShares = this.customSharesInput(
            body.customShares,
            input.currency,
          );
        this.validateCurrencyTotals(round.totals, input);
        if (!round.created)
          throw new Error('Validated expense was not inserted');
        const amounts = participantIds.map(
          (id) =>
            assignedShares.find((share) => share.userId === id)
              ?.assignedAmountMinor ?? null,
        );
        const result = await this.repository.finishExpenseCreation(
          client,
          id,
          roundId,
          userId,
          key,
          digest,
          participantIds,
          amounts,
          now,
          round.version,
        );
        if (!result) throw new SettleException(settleErrors.STALE_ROUND);
        captureAudience?.({ groupId: round.group_id, userIds: round.user_ids });
        return result;
      },
      undefined,
      async (client) => {
        userId = (await this.authorization.requireAccount(client, access)).id;
        digest = mutationDigest(key, {
          roundId,
          expenseId: undefined,
          ...body,
        });
        input = this.expenseFields(body);
        if (
          typeof body.expectedVersion !== 'number' ||
          !Number.isSafeInteger(body.expectedVersion) ||
          body.expectedVersion < 1
        )
          throw new SettleException(settleErrors.VERSION_REQUIRED);
        if (input.splitMode === 'ALL') {
          if (body.participantIds !== undefined)
            throw new SettleException(
              settleErrors.ALL_PARTICIPANTS_ARE_SERVER_SELECTED,
            );
        } else if (input.splitMode === 'CUSTOM') {
          if (body.participantIds !== undefined)
            throw new SettleException(
              settleErrors.CUSTOM_PARTICIPANTS_REQUIRE_SHARES,
            );
          assignedShares = this.customSharesInput(
            body.customShares,
            input.currency,
          );
          participantIds = idsInput(
            assignedShares.map((share) => share.userId),
          );
          this.checkCustomShares(
            BigInt(input.amount),
            participantIds,
            assignedShares,
          );
        } else participantIds = idsInput(body.participantIds);
      },
    );
  }

  private validateExpenseUpdate(
    round: ExpenseUpdateRow,
    userId: string,
    expectedVersion: unknown,
  ) {
    if (!round.id || !round.expense) throw missing();
    this.state(round, 'RECORDING');
    if (
      !round.is_creator &&
      (!round.active_ids.includes(userId) || round.expense.author_id !== userId)
    ) {
      throw new SettleException(settleErrors.EXPENSE_EDITOR_ONLY);
    }
    this.version(round, expectedVersion);
  }

  async saveExpense(
    access: Identity,
    key: string,
    roundId: string,
    body: ExpenseRequestDTO | Record<string, unknown>,
    expenseId?: string,
    captureAudience?: (audience: {
      groupId: string;
      userIds: string[];
    }) => void,
  ) {
    if (!expenseId)
      return this.createExpense(access, key, roundId, body, captureAudience);
    return this.prisma.withDatabaseConnection(
      async (client, discardConnection) => {
        const userId = (await this.authorization.requireAccount(client, access))
          .id;
        const digest = mutationDigest(key, { roundId, expenseId, ...body });
        const round = (
          await this.repository.findExpenseUpdate(
            client,
            roundId,
            expenseId,
            userId,
            key,
          )
        ).rows[0];
        const replay = mutationResult<MutationResult>(round, digest);
        if (replay) return replay;
        this.validateExpenseUpdate(round, userId, body.expectedVersion);
        const previous = round.expense!;
        const input = this.expenseInput(round, body, previous);
        this.validateCurrencyTotals(round.totals, input, previous);
        const maximum = minorLimit(MAX_ROUND_TOTAL_MAJOR, input.currency);
        const amounts = input.participantIds.map(
          (id) =>
            input.assignedShares.find((share) => share.userId === id)
              ?.assignedAmountMinor ?? null,
        );
        return this.prisma.withWriteLock(
          client,
          discardConnection,
          async (client) => {
            const result = await this.repository.updateExpense(
              client,
              expenseId,
              roundId,
              userId,
              key,
              digest,
              input,
              amounts,
              round.version,
              maximum.toString(),
              nowSeconds(),
            );
            if (!result) {
              // A concurrent winner may have committed this same key after our SELECT.
              const current = (
                await this.repository.findExpenseUpdate(
                  client,
                  roundId,
                  expenseId,
                  userId,
                  key,
                )
              ).rows[0];
              const replay = mutationResult<MutationResult>(current, digest);
              if (replay) return replay;
              this.validateExpenseUpdate(current, userId, body.expectedVersion);
              throw new SettleException(settleErrors.STALE_ROUND);
            }
            captureAudience?.({
              groupId: round.group_id,
              userIds: round.user_ids,
            });
            return result;
          },
        );
      },
    );
  }

  private validateEditableExpense(
    round: Omit<
      ExpenseDeletionRow,
      | 'actor_active'
      | 'user_ids'
      | 'object_keys'
      | 'request_digest'
      | 'response_metadata'
      | 'deleted'
    >,
    userId: string,
    expectedVersion: unknown,
  ) {
    if (!round.id || !round.expense_id) throw missing();
    this.state(round, 'RECORDING');
    if (
      !round.is_creator &&
      (round.viewer_excluded_at !== null || round.author_id !== userId)
    ) {
      throw new SettleException(settleErrors.EXPENSE_EDITOR_ONLY);
    }
    this.version(round, expectedVersion);
  }

  async deleteExpense(
    access: Identity,
    key: string,
    roundId: string,
    expenseId: string,
    body: VersionRequestDTO | Record<string, unknown>,
    captureAudience?: (audience: {
      groupId: string;
      userIds: string[];
    }) => void,
  ) {
    let userId: string,
      digest: string,
      round: ExpenseDeletionRow,
      replay: MutationResult | null;
    let audience: { groupId: string; userIds: string[] } | undefined;
    let objectKeys: string[] = [];
    const result = await this.prisma.withWriteTransaction(
      async (client) => {
        if (replay) return replay;
        const current = await this.repository.deleteExpense(
          client,
          roundId,
          expenseId,
          userId,
          key,
          digest,
          round.version,
          nowSeconds(),
        );
        if (!current.actor_active)
          throw new SettleException(settleErrors.UNAUTHORIZED);
        const result = mutationResult<MutationResult>(current, digest);
        if (!result) {
          this.validateEditableExpense(current, userId, body.expectedVersion);
          throw new SettleException(settleErrors.STALE_ROUND);
        }
        if (current.deleted) {
          objectKeys = current.object_keys;
          audience = { groupId: current.group_id, userIds: current.user_ids };
        }
        return result;
      },
      async (client) => {
        userId = (await this.authorization.requireAccount(client, access)).id;
        onlyKeys(body, ['expectedVersion']);
        digest = mutationDigest(key, { roundId, expenseId, ...body });
        round = (
          await this.repository.findExpenseDeletion(
            client,
            roundId,
            expenseId,
            userId,
            key,
          )
        ).rows[0];
        replay = mutationResult<MutationResult>(round, digest);
        if (!replay)
          this.validateEditableExpense(round, userId, body.expectedVersion);
      },
    );
    await this.cleanupReceiptObjects(objectKeys);
    if (audience) captureAudience?.(audience);
    return result;
  }

  private async cleanupReceiptObjects(keys: string[]) {
    for (const key of keys) {
      try {
        await this.storage.deleteReceiptObject(key);
      } catch (error) {
        console.error('receipt_cleanup_failed', key, error);
      }
    }
  }

  private async exclusions(
    client: Database,
    round: RoundRow,
    targetId: string,
  ): Promise<ExclusionCheck> {
    const {
      rows: [member],
    } = await this.repository.findExclusionExpenses(client, round.id, targetId);
    if (!member) throw missing();
    return this.exclusionCheck(round, targetId, member);
  }

  private exclusionCheck(
    round: RoundRow,
    targetId: string,
    member: Pick<
      MemberExclusionRow,
      'excluded_at' | 'member_count' | 'expenses'
    >,
  ): ExclusionCheck {
    const rows = member.expenses;
    const reason =
      round.creator_id === targetId
        ? 'round_creator_cannot_leave'
        : member.excluded_at !== null
          ? 'already_excluded'
          : !['RECORDING', 'CONFIRMED'].includes(round.status)
            ? 'invalid_round_state'
            : rows.length
              ? 'member_exclusion_blocked'
              : Number(member.member_count) <= 2
                ? 'minimum_participants'
                : null;
    return {
      allowed: reason === null,
      reason,
      expenses: rows.map((e) => ({
        id: e.id,
        description: e.description,
        currency: e.currency,
        amountMinor: e.amount_minor,
        authorId: e.author_id,
        authorName: e.author_name,
        reason: e.reason,
      })),
    };
  }

  async checkExclusion(access: Identity, roundId: string, userId: string) {
    return this.prisma.withDatabaseConnection(async (client) => {
      const account = await this.authorization.requireAccount(client, access),
        round = await this.roundFor(client, roundId, account.id);
      this.creator(round);
      return this.exclusions(client, round, userId);
    });
  }

  async excludeMember(
    access: Identity,
    key: string,
    roundId: string,
    targetId: string,
    body: VersionRequestDTO | Record<string, unknown>,
    captureAudience?: (audience: {
      groupId: string;
      userIds: string[];
      groupUserIds: string[];
    }) => void,
  ) {
    return this.prisma.withDatabaseConnection(async (client) => {
      const account = await this.authorization.requireAccount(client, access);
      onlyKeys(body, ['expectedVersion']);
      mutationDigest(key, { roundId, targetId, ...body });
      const {
        rows: [round],
      } = await this.repository.findMemberExclusion(
        client,
        roundId,
        targetId,
        account.id,
      );
      if (!round) throw missing();
      this.creator(round);
      if (!round.target_id || round.excluded_at !== null) throw missing();
      this.state(round, 'RECORDING');
      this.version(round, body.expectedVersion);
      const check = this.exclusionCheck(round, targetId, round);
      if (!check.allowed)
        throw new AppError(
          409,
          check.reason === 'minimum_participants'
            ? check.reason
            : 'member_exclusion_blocked',
          check.expenses.length
            ? '해당 사용자와 연관된 정산이 있습니다.'
            : check.reason === 'minimum_participants'
              ? '회차는 최소 2명이어야 합니다'
              : '해당 사용자는 제외할 수 없어요',
          check,
        );
      const result = await this.repository.excludeMember(
        client,
        roundId,
        targetId,
        account.id,
        round.version,
        nowSeconds(),
      );
      if (!result) throw new SettleException(settleErrors.STALE_ROUND);
      captureAudience?.({
        groupId: round.group_id,
        userIds: round.user_ids,
        groupUserIds: round.group_user_ids,
      });
      return result;
    });
  }

  private async validatedExpenses(client: Database, roundId: string) {
    const members = await this.membersFor(client, roundId),
      items = await this.settlementExpensesFor(client, roundId);
    return this.validateExpenses(items, members);
  }

  private validateExpenses(
    items: Awaited<ReturnType<SettleService['settlementExpensesFor']>>,
    members: RoundMember[],
  ) {
    const active = members
      .filter((m) => m.excludedAt === null)
      .map((m) => m.userId)
      .sort();
    if (active.length < 2)
      throw new SettleException(settleErrors.INSUFFICIENT_PARTICIPANTS);
    if (!items.length) throw new SettleException(settleErrors.EMPTY_EXPENSES);
    const totals = new Map<Currency, bigint>();
    for (const expense of items) {
      if (
        !expense.participantIds.length ||
        expense.participantIds.some((id) => !active.includes(id)) ||
        !members.some((m) => m.userId === expense.payerId) ||
        (expense.splitMode === 'ALL' &&
          JSON.stringify(expense.participantIds.slice().sort()) !==
            JSON.stringify(active))
      ) {
        throw new SettleException(settleErrors.INVALID_PARTICIPANTS);
      }
      const currency = requireCurrency(expense.currency);
      const amount = BigInt(expense.amountMinor);
      if (amount <= 0n) badInput('invalid_amount');
      if (expense.splitMode === 'CUSTOM')
        this.checkCustomShares(amount, expense.participantIds, expense.shares);
      if (amount > minorLimit(MAX_EXPENSE_MAJOR, currency))
        throw new SettleException({
          ...settleErrors.EXPENSE_AMOUNT_LIMIT_EXCEEDED,
          message: `지출 금액은 ${formatMoney(minorLimit(MAX_EXPENSE_MAJOR, currency).toString(), currency)} 이하여야 해요`,
        });
      totals.set(currency, (totals.get(currency) ?? 0n) + amount);
    }
    if (totals.size > MAX_ROUND_CURRENCIES)
      throw new SettleException(settleErrors.CURRENCY_LIMIT_EXCEEDED);
    for (const [currency, total] of totals)
      if (total > minorLimit(MAX_ROUND_TOTAL_MAJOR, currency))
        throw new SettleException({
          ...settleErrors.ROUND_TOTAL_LIMIT_EXCEEDED,
          message: `통화별 전체 지출은 ${formatMoney(minorLimit(MAX_ROUND_TOTAL_MAJOR, currency).toString(), currency)} 이하여야 해요`,
        });
    return { items, members };
  }

  private async finalize(
    client: Database,
    roundId: string,
    { items, members }: Awaited<ReturnType<SettleService['validatedExpenses']>>,
  ) {
    const result = finalizeCurrencySettlement(
      items,
      members.map((m) => m.userId),
    );
    await this.repository.saveFinalSettlement(
      client,
      roundId,
      result,
      nowSeconds(),
    );
  }

  private validateRoundConfirmation(
    round: RoundConfirmationRow,
    expectedVersion: unknown,
  ) {
    if (!round.id) throw missing();
    this.creator(round);
    this.version(round, expectedVersion);
    this.state(round, 'RECORDING');
    this.validateExpenses(
      round.expenses.map(this.settlementExpenseDetails),
      round.members.map(this.memberDetails),
    );
  }

  private async confirmRound(
    access: Identity,
    key: string,
    roundId: string,
    body: VersionRequestDTO | Record<string, unknown>,
    captureAudience?: (audience: {
      groupId: string;
      userIds: string[];
    }) => void,
  ): Promise<MutationResult> {
    let userId: string,
      digest: string,
      round: RoundConfirmationRow,
      replay: MutationResult | null;
    return this.prisma.withWriteTransaction(
      async (client) => {
        if (replay) return replay;
        const current = await this.repository.confirmRound(
          client,
          roundId,
          userId,
          key,
          digest,
          round.version,
          nowSeconds(),
        );
        if (!current.actor_active)
          throw new SettleException(settleErrors.UNAUTHORIZED);
        const result = mutationResult<MutationResult>(current, digest);
        if (!result) {
          this.validateRoundConfirmation(current, body.expectedVersion);
          throw new SettleException(settleErrors.STALE_ROUND);
        }
        if (current.confirmed)
          captureAudience?.({
            groupId: current.group_id,
            userIds: current.user_ids,
          });
        return result;
      },
      async (client) => {
        const {
          rows: [current],
        } = await this.repository.findRoundConfirmation(
          client,
          roundId,
          userId,
          key,
        );
        round = current;
        replay = mutationResult<MutationResult>(round, digest);
        if (!replay)
          this.validateRoundConfirmation(round, body.expectedVersion);
      },
      async (client) => {
        userId = (await this.authorization.requireAccount(client, access)).id;
        onlyKeys(body, ['expectedVersion']);
        digest = mutationDigest(key, { roundId, ...body });
      },
    );
  }

  async roundCommand(
    access: Identity,
    key: string,
    roundId: string,
    action: string,
    body: VersionRequestDTO | Record<string, unknown>,
    captureAudience?: (audience: {
      groupId: string;
      userIds: string[];
    }) => void,
  ): Promise<MutationResult> {
    if (action === 'confirm')
      return this.confirmRound(access, key, roundId, body, captureAudience);
    if (action === 'force-complete')
      return this.prisma.withDatabaseConnection(async (client) => {
        const account = await this.authorization.requireAccount(client, access);
        onlyKeys(body, ['expectedVersion']);
        const digest = mutationDigest(key, { roundId, ...body });
        const {
          rows: [round],
        } = await this.repository.findRoundForceCompletion(
          client,
          roundId,
          account.id,
          key,
        );
        const replay = mutationResult<MutationResult>(round, digest);
        if (replay) return replay;
        if (!round.id) throw missing();
        this.creator(round);
        this.version(round, body.expectedVersion);
        this.state(round, 'LOCKED');
        if (round.finalized_at === null)
          throw new SettleException(settleErrors.PENDING_REMAINDER);
        const current = await this.repository
          .forceCompleteRound(
            client,
            roundId,
            account.id,
            key,
            digest,
            round.version,
            nowSeconds(),
          )
          .catch((error) => {
            if (
              error?.code === '23505' &&
              error.constraint === 'mutation_requests_pkey'
            ) {
              throw new SettleException(settleErrors.IDEMPOTENCY_CONFLICT);
            }
            throw error;
          });
        if (!current.actor_active)
          throw new SettleException(settleErrors.UNAUTHORIZED);
        const result = mutationResult<MutationResult>(current, digest);
        if (!result) {
          if (!current.id) throw missing();
          this.creator(current);
          this.version(current, body.expectedVersion);
          this.state(current, 'LOCKED');
          if (current.finalized_at === null)
            throw new SettleException(settleErrors.PENDING_REMAINDER);
          throw new SettleException(settleErrors.STALE_ROUND);
        }
        if (current.completed)
          captureAudience?.({
            groupId: round.group_id,
            userIds: round.user_ids,
          });
        return result;
      });
    if (action === 'complete')
      return this.prisma.withDatabaseConnection(async (client) => {
        const account = await this.authorization.requireAccount(client, access);
        onlyKeys(body, ['expectedVersion']);
        const digest = mutationDigest(key, { roundId, ...body });
        const expectedVersion =
          typeof body.expectedVersion === 'number' &&
          Number.isSafeInteger(body.expectedVersion)
            ? body.expectedVersion
            : null;
        const current = await this.repository.completeCheckedRound(
          client,
          roundId,
          account.id,
          key,
          digest,
          expectedVersion,
          nowSeconds(),
        );
        if (!current.actor_active)
          throw new SettleException(settleErrors.UNAUTHORIZED);
        const result = mutationResult<MutationResult>(current, digest);
        if (!result) {
          if (!current.id) throw missing();
          this.creator(current);
          this.version(current, body.expectedVersion);
          this.state(current, 'LOCKED');
          if (current.finalized_at === null)
            throw new SettleException(settleErrors.PENDING_REMAINDER);
          if (current.pending_count)
            throw new SettleException(settleErrors.PENDING_SETTLEMENT_CHECKS, {
              pendingCount: current.pending_count,
            });
          throw new SettleException(settleErrors.STALE_ROUND);
        }
        if (current.completed)
          captureAudience?.({
            groupId: current.group_id,
            userIds: current.user_ids,
          });
        return result;
      });
    if (action === 'draw')
      return this.prisma.withDatabaseConnection(async (client) => {
        const account = await this.authorization.requireAccount(client, access);
        onlyKeys(body, ['expectedVersion']);
        const digest = mutationDigest(key, { roundId, ...body });
        const {
          rows: [round],
        } = await this.repository.findRoundConfirmation(
          client,
          roundId,
          account.id,
          key,
          'draw',
        );
        const replay = mutationResult<MutationResult>(round, digest);
        if (replay) return replay;
        if (!round.id) throw missing();
        this.creator(round);
        let settlement: ReturnType<typeof finalizeCurrencySettlement> | null =
          null;
        if (round.finalized_at === null) {
          this.version(round, body.expectedVersion);
          this.state(round, 'LOCKED');
          const { items, members } = this.validateExpenses(
            round.expenses.map(this.settlementExpenseDetails),
            round.members.map(this.memberDetails),
          );
          settlement = finalizeCurrencySettlement(
            items,
            members.map((member) => member.userId),
            (max) => randomInt(max),
          );
        }
        const current = await this.repository.drawRound(
          client,
          roundId,
          account.id,
          key,
          digest,
          round.version,
          nowSeconds(),
          settlement,
        );
        if (!current.actor_active)
          throw new SettleException(settleErrors.UNAUTHORIZED);
        const result = mutationResult<MutationResult>(current, digest);
        if (!result) {
          if (!current.id) throw missing();
          this.creator(current);
          this.state(current, 'LOCKED');
          this.version(current, body.expectedVersion);
          throw new SettleException(settleErrors.STALE_ROUND);
        }
        if (current.drawn)
          captureAudience?.({
            groupId: round.group_id,
            userIds: round.user_ids,
          });
        return result;
      });
    if (action === 'reopen')
      return this.prisma.withDatabaseConnection(async (client) => {
        const account = await this.authorization.requireAccount(client, access);
        onlyKeys(body, ['expectedVersion']);
        mutationDigest(key, { roundId, ...body });
        const {
          rows: [round],
        } = await this.repository.findRoundReopening(
          client,
          roundId,
          account.id,
        );
        if (!round) throw missing();
        this.creator(round);
        this.state(round, 'CONFIRMED');
        this.version(round, body.expectedVersion);
        const result = await this.repository.reopenRound(
          client,
          roundId,
          account.id,
          round.version,
        );
        if (!result) throw new SettleException(settleErrors.STALE_ROUND);
        captureAudience?.({ groupId: round.group_id, userIds: round.user_ids });
        return result;
      });
    if (action === 'cancel') {
      let userId: string;
      return this.prisma.withWriteTransaction(
        async (client) => {
          onlyKeys(body, ['expectedVersion']);
          const digest = mutationDigest(key, { roundId, ...body });
          const {
            rows: [round],
          } = await this.repository.findRoundCancellation(
            client,
            roundId,
            userId,
            key,
          );
          const replay = mutationResult<MutationResult>(round, digest);
          if (replay) return replay;
          if (!round.id) throw missing();
          this.creator(round);
          this.version(round, body.expectedVersion);
          this.state(round, 'RECORDING');
          if (round.has_expenses)
            throw new SettleException(settleErrors.ROUND_HAS_EXPENSES);
          const result = { id: roundId, roundId };
          await this.repository.deleteRound(
            client,
            roundId,
            userId,
            key,
            digest,
            result,
            nowSeconds(),
          );
          captureAudience?.({
            groupId: round.group_id,
            userIds: round.user_ids,
          });
          return result;
        },
        async (client) => {
          userId = (await this.authorization.requireAccount(client, access)).id;
        },
      );
    }
    onlyKeys(body, ['expectedVersion']);
    if (action !== 'send') throw missing();
    return this.mutations.execute(
      access,
      key,
      `round.${action}`,
      { roundId, ...body },
      async (client, userId) => {
        const round = await this.roundFor(client, roundId, userId);
        this.creator(round);
        this.version(round, body.expectedVersion);
        const now = nowSeconds();
        if (action === 'send') {
          this.state(round, 'CONFIRMED');
          const expenses = await this.validatedExpenses(client, roundId);
          const { count } = await this.repository.lockRound(
            client,
            roundId,
            now,
            round.version,
          );
          if (!count) throw new SettleException(settleErrors.STALE_ROUND);
          if (!(await this.repository.hasRemainder(client, roundId)))
            await this.finalize(client, roundId, expenses);
          captureAudience?.({
            groupId: round.group_id,
            userIds: expenses.members.map((member) => member.userId),
          });
        }
        return this.bump(client, roundId, round.version);
      },
    );
  }

  async setSettlementCheck(
    access: Identity,
    key: string,
    roundId: string,
    body: SettlementCheckRequestDTO | Record<string, unknown>,
    captureAudience?: (audience: {
      groupId: string;
      userIds: string[];
    }) => void,
  ) {
    return this.prisma.withDatabaseConnection(async (client) => {
      const account = await this.authorization.requireAccount(client, access);
      onlyKeys(body, ['expectedVersion', 'checked', 'senderId', 'currency']);
      if (typeof body.checked !== 'boolean')
        throw new SettleException(settleErrors.CHECK_STATE_REQUIRED);
      if (
        body.senderId !== undefined &&
        (typeof body.senderId !== 'string' ||
          body.senderId !== body.senderId.trim() ||
          !/^[\w-]{1,128}$/.test(body.senderId))
      )
        throw new SettleException(settleErrors.INVALID_SENDER);
      mutationDigest(key, { roundId, ...body });
      let currency: Currency | undefined;
      if (body.currency !== undefined) {
        try {
          currency = requireCurrency(body.currency);
        } catch {
          throw new SettleException(settleErrors.UNSUPPORTED_TRANSFER_CURRENCY);
        }
      }
      if (body.senderId !== undefined && !currency)
        throw new SettleException(settleErrors.TRANSFER_CURRENCY_REQUIRED);
      const senderId = body.senderId as string | undefined;
      const {
        rows: [round],
      } = await this.repository.findSettlementCheck(
        client,
        roundId,
        account.id,
      );
      if (!round) throw missing();
      this.version(round, body.expectedVersion);
      this.state(round, 'LOCKED');
      if (round.finalized_at === null)
        throw new SettleException(settleErrors.UNFINALIZED_SETTLEMENT);
      const incoming = round.incoming.filter(
        (transfer) =>
          (senderId === undefined || transfer.sender_id === senderId) &&
          (currency === undefined || transfer.currency === currency),
      );
      if (!incoming.length)
        throw new SettleException(settleErrors.NO_RECEIVABLE_TRANSFERS);
      if (
        !incoming.some(
          (transfer) => (transfer.received_at !== null) !== body.checked,
        )
      )
        throw new SettleException(settleErrors.TRANSFER_NOT_FOUND);
      const { rowCount } = await this.repository.setReceived(
        client,
        roundId,
        account.id,
        senderId ?? null,
        body.checked,
        nowSeconds(),
        round.version,
        currency ?? null,
      );
      if (!rowCount) throw new SettleException(settleErrors.TRANSFER_NOT_FOUND);
      captureAudience?.({ groupId: round.group_id, userIds: round.user_ids });
      return {
        id: roundId,
        roundId,
        status: round.status,
        version: round.version,
      };
    });
  }

  async getSettlement(
    access: Identity,
    roundId: string,
  ): Promise<SettlementDTO> {
    return this.prisma.withDatabaseConnection(async (client) => {
      const account = await this.authorization.requireAccount(client, access);
      const {
        rows: [round],
      } = await this.repository.findSettlement(client, roundId, account.id);
      if (!round) throw missing();
      const checks = round.confirmations.map((row) => ({
        userId: row.user_id,
        displayName: row.display_name_snapshot,
        profileImageUrl: row.profile_image_url,
        checkedAt: row.checked_at === null ? null : Number(row.checked_at),
      }));
      const viewerCheck = checks.find((member) => member.userId === account.id);
      const checkedCount = checks.filter(
        (member) => member.checkedAt !== null,
      ).length;
      const result: SettlementDTO = {
        roundId,
        name: round.name,
        groupName: round.group_name,
        status: round.status,
        version: round.version,
        isCreator: round.is_creator,
        finalized: round.finalized_at !== null,
        balances: [],
        checkedAt: viewerCheck?.checkedAt ?? null,
        checkRequired: Boolean(viewerCheck),
        checkedCount,
        requiredCount: checks.length,
        allChecked: checkedCount === checks.length,
        confirmations: checks,
        outgoing: [],
        incoming: [],
        sharePath: null,
      };
      if (!result.finalized) return result;
      result.balances = round.balances ?? [];
      result.sharePath = `/settlements/${roundId}`;
      result.outgoing = round.outgoing.map((row) => ({
        currency: row.currency,
        receiverId: row.receiver_id,
        displayName: row.display_name_snapshot,
        profileImageUrl: row.profile_image_url,
        amountMinor: row.amount_minor,
        ...(row.currency === 'KRW'
          ? {
              account: {
                bankName: bankDisplayName(row.bank_name),
                accountNumber: row.account_number,
                formattedAccountNumber: row.account_number_formatted,
                accountHolder: row.account_holder,
                verifiedAt:
                  row.bank_verified_at === null
                    ? null
                    : Number(row.bank_verified_at),
              },
            }
          : {}),
      }));
      result.incoming = round.incoming.map((row) => ({
        currency: row.currency,
        senderId: row.sender_id,
        displayName: row.display_name_snapshot,
        profileImageUrl: row.profile_image_url,
        amountMinor: row.amount_minor,
        receivedAt: row.received_at === null ? null : Number(row.received_at),
      }));
      return result;
    });
  }

  async addReceipt(
    access: Identity,
    key: string,
    roundId: string,
    expenseId: string,
    ...input:
      | [
          expectedVersion: number,
          bytes: Uint8Array,
          type: string,
          captureAudience?: ReceiptAudience,
        ]
      | [
          readUpload: () => Promise<ReceiptUpload>,
          captureAudience?: ReceiptAudience,
        ]
  ) {
    if (!access) throw new SettleException(settleErrors.UNAUTHORIZED);
    const account = await this.prisma.withDatabaseConnection((client) =>
      this.authorization.requireAccount(client, access),
    );
    const upload: ReceiptUpload =
      typeof input[0] === 'function'
        ? await input[0]()
        : {
            expectedVersion: input[0],
            bytes: input[1] as Uint8Array,
            type: input[2] as string,
          };
    const captureAudience =
      typeof input[0] === 'function'
        ? (input[1] as ReceiptAudience | undefined)
        : input[3];
    const { expectedVersion, bytes, type } = upload;
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
      throw new SettleException(settleErrors.VERSION_REQUIRED);
    const file = await validateReceipt(bytes, type, upload.name);
    const sourceSha256 = file.sha256;
    const digest = mutationDigest(key, {
      roundId,
      expenseId,
      expectedVersion,
      sourceSha256,
      type,
    });
    const id = randomUUID();
    // Only an accepted attempt creates a receipt and its durable job, in the same SQL statement.
    let current;
    try {
      current = await this.prisma.withDatabaseConnection((client) =>
        this.repository.enqueueReceipt(
          client,
          roundId,
          expenseId,
          account.id,
          key,
          digest,
          expectedVersion,
          id,
          file.mimeType,
          file.content.length,
          file.sha256,
          file.content.toString('base64'),
          nowSeconds(),
        ),
      );
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === '23505'
      )
        throw new SettleException(settleErrors.IDEMPOTENCY_CONFLICT);
      throw error;
    }
    if (!current.actor_active)
      throw new SettleException(settleErrors.UNAUTHORIZED);
    const result = mutationResult<MutationResult>(current, digest);
    if (!result) {
      this.validateEditableExpense(current, account.id, expectedVersion);
      throw new SettleException(settleErrors.STALE_ROUND);
    }
    if (current.inserted)
      captureAudience?.({
        groupId: current.group_id,
        userIds: current.user_ids,
      });
    return result;
  }

  async removeReceipt(
    access: Identity,
    key: string,
    roundId: string,
    expenseId: string,
    receiptId: string,
    body: VersionRequestDTO | Record<string, unknown>,
    captureAudience?: ReceiptAudience,
  ) {
    let objectKey: string | null = null;
    let audience: Parameters<ReceiptAudience>[0] | undefined;
    const result = await this.prisma.withDatabaseConnection(async (client) => {
      const account = await this.authorization.requireAccount(client, access);
      onlyKeys(body, ['expectedVersion']);
      const digest = mutationDigest(key, {
        roundId,
        expenseId,
        receiptId,
        ...body,
      });
      const round = (
        await this.repository.findReceiptDeletion(
          client,
          roundId,
          expenseId,
          receiptId,
          account.id,
          key,
        )
      ).rows[0];
      const replay = mutationResult<MutationResult>(round, digest);
      if (replay) return replay;
      this.validateEditableExpense(round, account.id, body.expectedVersion);
      if (!round.receipt_id) throw missing();
      const current = await this.repository
        .deleteReceipt(
          client,
          roundId,
          expenseId,
          receiptId,
          account.id,
          key,
          digest,
          round.version,
          nowSeconds(),
        )
        .catch((error) => {
          if (error && typeof error === 'object' && error.code === '23505') {
            throw new SettleException(settleErrors.IDEMPOTENCY_CONFLICT);
          }
          throw error;
        });
      if (!current.actor_active)
        throw new SettleException(settleErrors.UNAUTHORIZED);
      let result = mutationResult<MutationResult>(current, digest);
      if (!result) {
        // A competing autocommit may finish after this statement's snapshot was taken.
        const latest = (
          await this.repository.findReceiptDeletion(
            client,
            roundId,
            expenseId,
            receiptId,
            account.id,
            key,
          )
        ).rows[0];
        if (!latest.actor_active)
          throw new SettleException(settleErrors.UNAUTHORIZED);
        result = mutationResult<MutationResult>(latest, digest);
        if (!result) {
          this.validateEditableExpense(
            latest,
            account.id,
            body.expectedVersion,
          );
          if (!latest.receipt_id) throw missing();
          throw new SettleException(settleErrors.STALE_ROUND);
        }
      }
      if (current.deleted) {
        objectKey = current.object_key;
        audience = { groupId: current.group_id, userIds: current.user_ids };
      }
      return result;
    });
    if (objectKey) await this.cleanupReceiptObjects([objectKey]);
    if (audience) captureAudience?.(audience);
    return result;
  }

  async getReceipt(access: Identity, receiptId: string) {
    const receipt = await this.prisma.withDatabaseConnection(async (client) => {
      const account = await this.authorization.requireAccount(client, access);
      const { rows } = await this.repository.findReceipt(
        client,
        receiptId,
        account.id,
      );
      if (!rows[0]) throw missing();
      return rows[0];
    });
    if (receipt.storage_status === 'PENDING')
      throw new SettleException(settleErrors.RECEIPT_PENDING);
    if (receipt.storage_status === 'FAILED')
      throw new SettleException(settleErrors.STORAGE_UNAVAILABLE);
    const content = receipt.object_key
      ? await this.storage.readReceipt(receipt.object_key)
      : receipt.content;
    if (!content) throw missing();
    return { mimeType: receipt.mime_type, content };
  }
}
