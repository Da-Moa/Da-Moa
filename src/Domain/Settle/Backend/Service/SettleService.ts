import 'server-only'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import { requireAccount } from '../../../../Global/Auth/Backend'
import { MAX_GROUP_MEMBERS } from '../../../Group/Shared'
import { AppError, badInput, withDatabaseConnection, withWriteLock, withWriteTransaction, mutationDigest, mutationResult, deleteReceiptObject, putReceipt, readReceipt, convertReceipt, type Database, domainMutation, idsInput, nowSeconds, onlyKeys, pageOf, pagination, textInput, type Identity } from '../../../../Global/Util/Backend'
import { MAX_ROUND_CURRENCIES, formatMoney, MAX_EXPENSE_MAJOR, MAX_ROUND_TOTAL_MAJOR, minorLimit, parseAmount, requireCurrency, type Currency, type CreateRoundRequestDTO, type ExpenseRequestDTO, type VersionRequestDTO, type SettlementCheckRequestDTO } from '../../Shared'
import { calculateBase, finalizeCurrencySettlement, previewCurrencySettlement, validateCustomShares } from '../../Shared'
import type { ExclusionCheck, Expense, MutationResult, RoundDetail, RoundMember, RoundStatus, RoundSummary, SettlementDTO, SettlementTransfer } from '../../Shared'

import type { RoundRow, RoundConfirmationRow, MemberRow, ExpenseRow, ShareRow, ReceiptRow, SettlementExpenseRow, ExpenseUpdateRow, ExpenseDeletionRow, MemberExclusionRow } from '../DAO/SettleDAO'
import { duplicateRound, missing } from '../Exception/SettleException'
import * as repository from '../Repository/SettleRepository'

async function roundFor(client: Database, id: string, userId: string): Promise<RoundRow> {
  const { rows } = await repository.findRound(client, id, userId)
  if (!rows[0]) throw missing()
  return rows[0]
}

function creator(round: RoundRow) {
  if (!round.is_creator) throw new AppError(403, 'forbidden', '회차 생성자만 할 수 있어요')
}

function state(round: RoundRow, expected: RoundStatus) {
  if (round.status !== expected || (expected !== 'COMPLETED' && round.completed_at !== null)) {
    throw new AppError(409, 'invalid_round_state', '현재 회차 상태에서는 할 수 없어요. 최신 상태를 확인해 주세요')
  }
}

function version(round: RoundRow, value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) badInput('invalid_version', '회차 버전이 필요합니다')
  if (round.version !== value) throw new AppError(409, 'stale_round', '다른 변경이 먼저 저장됐어요. 최신 내역을 확인해 주세요', { version: round.version })
}

async function bump(client: Database, id: string, expectedVersion: number): Promise<MutationResult> {
  const { rows } = await repository.bumpRound(client, id, expectedVersion)
  if (!rows[0]) throw new AppError(409, 'stale_round', '다른 변경이 먼저 저장됐어요. 최신 내역을 확인해 주세요')
  return { ...rows[0], roundId: id }
}

function memberDetails(row: MemberRow): RoundMember {
  return { userId: row.user_id, displayName: row.display_name_snapshot, profileImageUrl: row.profile_image_url, excludedAt: row.excluded_at === null ? null : Number(row.excluded_at) }
}

async function membersFor(client: Database, roundId: string): Promise<RoundMember[]> {
  const { rows } = await repository.findMembers(client, roundId)
  return rows.map(memberDetails)
}

function expenseDetails(row: ExpenseRow, part: Omit<ShareRow, 'expense_id'>[], receipts: Pick<ReceiptRow, 'id' | 'mime_type' | 'byte_size'>[]): Expense {
  const base = row.split_mode === 'CUSTOM' ? null : calculateBase(BigInt(row.amount_minor), part.length)
  return {
    id: row.id, authorId: row.author_id, payerId: row.payer_id, description: row.description, currency: row.currency, amountMinor: row.amount_minor,
    splitMode: row.split_mode, participantIds: part.map(s => s.user_id), baseShareMinor: base ? row.base_share_minor ?? base.base.toString() : null, remainderUnits: base ? row.remainder_units ?? base.remainder : 0,
    shares: part.map(s => ({ userId: s.user_id, assignedAmountMinor: s.assigned_amount_minor, amountMinor: s.final_amount_minor, receivedRemainder: s.received_remainder })),
    receipts: receipts.map(r => ({ id: r.id, mimeType: r.mime_type, byteSize: r.byte_size })),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  }
}

async function settlementExpensesFor(client: Database, roundId: string): Promise<(Pick<Expense, 'id' | 'payerId' | 'amountMinor' | 'splitMode' | 'currency' | 'participantIds'> & { shares: Pick<Expense['shares'][number], 'userId' | 'assignedAmountMinor'>[] })[]> {
  const { rows } = await repository.findSettlementExpenses(client, roundId)
  return rows.map(settlementExpenseDetails)
}

function settlementExpenseDetails(row: SettlementExpenseRow) {
  return { id: row.id, payerId: row.payer_id, currency: row.currency, amountMinor: row.amount_minor, splitMode: row.split_mode, participantIds: row.participant_ids, shares: row.shares ?? [] }
}

function summary(row: RoundRow): RoundSummary {
  return {
    id: row.id, groupId: row.group_id, groupName: row.group_name, name: row.name,
    status: row.status, version: row.version, createdAt: Number(row.created_at),
    finalizedAt: row.finalized_at === null ? null : Number(row.finalized_at), completedAt: row.completed_at === null ? null : Number(row.completed_at),
    totals: row.totals ?? [], memberCount: Number(row.member_count ?? 0),
  }
}

export async function listRounds(access: Identity, query: URLSearchParams, groupId?: string) {
  return withDatabaseConnection(async client => {
    const account = await requireAccount(client, access)
    const { limit, cursor } = pagination(query)
    const status = query.get('status')
    const search = query.has('q') ? textInput(query.get('q'), 100) : null
    if (status && !['active', 'RECORDING', 'CONFIRMED', 'LOCKED', 'COMPLETED'].includes(status)) badInput()
    const { rows } = await repository.findRounds(client, account.id, groupId ?? null, status, search, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1)
    return pageOf(rows.map(summary), limit, row => row)
  })
}

export async function getRound(access: Identity, roundId: string, query: URLSearchParams): Promise<RoundDetail> {
  return withDatabaseConnection(async client => {
    const account = await requireAccount(client, access)
    const { limit, cursor } = pagination(query)
    const { rows } = await repository.findRoundDetail(client, roundId, account.id, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1)
    const round = rows[0]
    if (!round) throw missing()
    const members = round.members.map(memberDetails)
    const expenses = pageOf(round.expenses.map(row => expenseDetails(row, row.shares, row.receipts)), limit, row => row)
    let transfers: SettlementTransfer[] = [], pendingRemainders: RoundDetail['pendingRemainders'] = []
    if (round.finalized_at === null) {
      const allExpenses = round.settlement_expenses.map(settlementExpenseDetails)
      if (allExpenses.length) ({ transfers, pendingRemainders } = previewCurrencySettlement(allExpenses, members.map(member => member.userId)))
    } else {
      transfers = round.transfers.map(row => ({ currency: row.currency, senderId: row.sender_id, receiverId: row.receiver_id, amountMinor: row.amount_minor }))
    }
    transfers = transfers.filter(transfer => transfer.senderId === account.id || transfer.receiverId === account.id)
    return {
      ...summary({ ...round, member_count: members.filter(m => m.excludedAt === null).length }),
      creatorId: round.creator_id, groupCreatorId: round.group_creator_id, isCreator: round.is_creator, members, expenses: expenses.items, expensesNextCursor: expenses.nextCursor,
      transfers, pendingRemainders,
    }
  })
}

export async function createRound(access: Identity, key: string, groupId: string, body: CreateRoundRequestDTO | Record<string, unknown>, captureAudience?: (userIds: string[]) => void) {
  return withDatabaseConnection((client, discardConnection) => withWriteLock(client, discardConnection, async () => {
    const account = await requireAccount(client, access)
    onlyKeys(body, ['name', 'participantIds'])
    const name = textInput(body.name, 100), ids = idsInput(body.participantIds)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) badInput('invalid_request_key', 'UUIDv7 회차 생성 ticket이 필요합니다')
    if (ids.length < 2 || !ids.includes(account.id)) throw new AppError(409, 'minimum_participants', '회차 생성자를 포함해 최소 2명을 선택해 주세요')
    const id = key.toLowerCase()
    try {
      const result = await repository.insertRound(client, id, groupId, account.id, name, nowSeconds(), ids)
      if (!result.actor_active) throw new AppError(401, 'unauthorized', '로그인이 필요합니다')
      if (!result.is_member) throw missing()
      if (!result.created) badInput('invalid_participants', '현재 모임 참여자만 선택할 수 있어요')
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505' && 'constraint' in error && error.constraint === 'rounds_pkey') throw duplicateRound()
      throw error
    }
    captureAudience?.(ids)
    return { id, roundId: id, status: 'RECORDING' as const, version: 1 }
  }))
}

function expenseFields(body: ExpenseRequestDTO | Record<string, unknown>, previous?: ExpenseRow): { currency: Currency; description: string; amount: string; payerId: string; splitMode: Expense['splitMode'] } {
  onlyKeys(body, ['currency', 'description', 'amount', 'payerId', 'splitMode', 'participantIds', 'customShares', 'expectedVersion'])
  let currency: Currency
  try { currency = requireCurrency(body.currency === undefined ? previous?.currency : body.currency) } catch { badInput('unsupported_currency', '지원하는 지출 통화를 선택해 주세요') }
  if (previous && currency !== previous.currency && body.amount === undefined) badInput('invalid_amount', '통화를 변경할 때 금액을 다시 입력해 주세요')
  if (previous?.split_mode === 'CUSTOM' && (body.splitMode ?? previous.split_mode) === 'CUSTOM' && currency !== previous.currency && body.customShares === undefined) badInput('invalid_amount', '통화를 변경할 때 개별 부담금을 다시 입력해 주세요')
  const description = textInput(body.description === undefined ? previous?.description : body.description, 500)
  let amount: bigint
  try { amount = body.amount === undefined && previous ? BigInt(previous.amount_minor) : parseAmount(body.amount, currency) } catch { badInput('invalid_amount', '통화에 맞는 양의 금액을 정확히 입력해 주세요') }
  const maximum = minorLimit(MAX_EXPENSE_MAJOR, currency)
  if (amount > maximum) badInput('expense_amount_limit_exceeded', `지출 금액은 ${formatMoney(maximum.toString(), currency)} 이하여야 해요`)
  const payerId = textInput(body.payerId === undefined ? previous?.payer_id : body.payerId, 128)
  const splitMode = body.splitMode === undefined ? previous?.split_mode : body.splitMode
  if (splitMode !== 'ALL' && splitMode !== 'SELECTED' && splitMode !== 'CUSTOM') badInput('invalid_participants', '분배 방식을 선택해 주세요')
  if (splitMode !== 'CUSTOM' && body.customShares !== undefined) badInput('invalid_input', '개별 부담금은 개별 항목 분배에서만 입력해 주세요')
  return { currency, description, amount: amount.toString(), payerId, splitMode }
}

function customSharesInput(value: unknown, currency: Currency) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_GROUP_MEMBERS) badInput('invalid_participants', '부담자와 부담금을 선택해 주세요')
  return value.map(share => {
    if (!share || typeof share !== 'object' || Array.isArray(share)) badInput('invalid_participants', '부담자와 부담금을 선택해 주세요')
    onlyKeys(share, ['userId', 'amount'])
    let assignedAmount: bigint
    try { assignedAmount = parseAmount(share.amount, currency) } catch { badInput('invalid_amount', '통화에 맞는 양의 부담금을 정확히 입력해 주세요') }
    return { userId: share.userId as string, assignedAmountMinor: assignedAmount.toString() }
  })
}

function expenseInput(round: ExpenseUpdateRow, body: ExpenseRequestDTO | Record<string, unknown>, previous: ExpenseRow) {
  const input = expenseFields(body, previous)
  const { payerId, splitMode } = input
  const active = round.active_ids
  if (!active.includes(payerId) && payerId !== previous?.payer_id) badInput('invalid_participants', '결제자는 이번 회차 참여자여야 합니다')
  let participantIds: string[]
  let assignedShares: { userId: string; assignedAmountMinor: string | null }[] = []
  if (splitMode === 'ALL') {
    if (body.participantIds !== undefined) badInput('invalid_participants', '전체 분배의 참여자는 서버에서 결정합니다')
    participantIds = active
  } else if (splitMode === 'CUSTOM') {
    if (body.participantIds !== undefined) badInput('invalid_input', '개별 항목 분배의 부담자는 부담금과 함께 선택해 주세요')
    if (body.customShares === undefined && previous?.split_mode === 'CUSTOM') {
      assignedShares = round.shares.map(share => ({ userId: share.user_id, assignedAmountMinor: share.assigned_amount_minor }))
    } else {
      assignedShares = customSharesInput(body.customShares, input.currency)
    }
    participantIds = idsInput(assignedShares.map(share => share.userId))
    if (participantIds.some(id => !active.includes(id))) badInput('invalid_participants', '부담자는 제외되지 않은 회차 참여자여야 합니다')
    checkCustomShares(BigInt(input.amount), participantIds, assignedShares)
  } else {
    participantIds = idsInput(body.participantIds === undefined ? round.shares.map(s => s.user_id) : body.participantIds)
    if (participantIds.some(id => !active.includes(id))) badInput('invalid_participants', '부담자는 제외되지 않은 회차 참여자여야 합니다')
  }
  if (!participantIds.length) badInput('invalid_participants', '부담자가 필요합니다')
  return { ...input, participantIds, assignedShares }
}

function validateCurrencyTotals(totals: RoundSummary['totals'], input: { currency: Currency; amount: string }, previous?: ExpenseRow) {
  const next = new Map(totals.map(total => [total.currency, BigInt(total.totalMinor)]))
  if (previous) next.set(previous.currency, (next.get(previous.currency) ?? 0n) - BigInt(previous.amount_minor))
  next.set(input.currency, (next.get(input.currency) ?? 0n) + BigInt(input.amount))
  if ([...next.values()].filter(amount => amount > 0n).length > MAX_ROUND_CURRENCIES) badInput('round_currency_limit_exceeded', '한 회차에는 최대 5개 통화를 기록할 수 있어요')
  const maximum = minorLimit(MAX_ROUND_TOTAL_MAJOR, input.currency)
  if (next.get(input.currency)! > maximum) badInput('round_total_limit_exceeded', `통화별 전체 지출은 ${formatMoney(maximum.toString(), input.currency)} 이하여야 해요`)
}

function checkCustomShares(amount: bigint, participantIds: string[], shares: { userId: string; assignedAmountMinor: string | null }[]) {
  try { validateCustomShares(amount, participantIds, shares) }
  catch (error) {
    const code = error instanceof Error ? error.message : 'invalid_amount'
    badInput(code, code === 'custom_share_total_mismatch' ? '부담금 합계가 총 금액과 일치해야 해요' : '개별 부담자와 부담금을 다시 확인해 주세요')
  }
}

async function createExpense(access: Identity, key: string, roundId: string, body: ExpenseRequestDTO | Record<string, unknown>, captureAudience?: (audience: { groupId: string; userIds: string[] }) => void) {
  let userId: string, digest: string, input: ReturnType<typeof expenseFields>
  let participantIds: string[] = [], assignedShares: ReturnType<typeof customSharesInput> = []
  return withWriteTransaction(async client => {
    const id = randomUUID(), now = nowSeconds()
    const round = await repository.insertExpenseCreation(client, id, roundId, userId, key, { ...input, participantIds }, body.expectedVersion as number,
      minorLimit(MAX_ROUND_TOTAL_MAJOR, input.currency).toString(), now)
    if (!round.actor_active) throw new AppError(401, 'unauthorized', '로그인이 필요합니다')
    const replay = mutationResult<MutationResult>(round, digest)
    if (replay) return replay
    if (!round.id) throw missing()
    state(round, 'RECORDING')
    if (!round.is_creator && !round.active_ids.includes(userId)) throw new AppError(403, 'forbidden', '지출 작성자 또는 회차 생성자만 수정할 수 있어요')
    version(round, body.expectedVersion)
    const actual = input
    if (!round.active_ids.includes(actual.payerId)) badInput('invalid_participants', '결제자는 이번 회차 참여자여야 합니다')
    if (actual.splitMode === 'ALL') participantIds = round.active_ids
    if (!participantIds.length || participantIds.some(id => !round.active_ids.includes(id))) badInput('invalid_participants', '부담자는 제외되지 않은 회차 참여자여야 합니다')
    if (actual.splitMode === 'CUSTOM') assignedShares = customSharesInput(body.customShares, input.currency)
    validateCurrencyTotals(round.totals, input)
    if (!round.created) throw new Error('Validated expense was not inserted')
    const amounts = participantIds.map(id => assignedShares.find(share => share.userId === id)?.assignedAmountMinor ?? null)
    const result = await repository.finishExpenseCreation(client, id, roundId, userId, key, digest, participantIds, amounts, now, round.version)
    if (!result) throw new AppError(409, 'stale_round', '다른 변경이 먼저 저장됐어요. 최신 내역을 확인해 주세요')
    captureAudience?.({ groupId: round.group_id, userIds: round.user_ids })
    return result
  }, undefined, async client => {
    userId = (await requireAccount(client, access)).id
    digest = mutationDigest(key, { roundId, expenseId: undefined, ...body })
    input = expenseFields(body)
    if (typeof body.expectedVersion !== 'number' || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1) badInput('invalid_version', '회차 버전이 필요합니다')
    if (input.splitMode === 'ALL') {
      if (body.participantIds !== undefined) badInput('invalid_participants', '전체 분배의 참여자는 서버에서 결정합니다')
    } else if (input.splitMode === 'CUSTOM') {
      if (body.participantIds !== undefined) badInput('invalid_input', '개별 항목 분배의 부담자는 부담금과 함께 선택해 주세요')
      assignedShares = customSharesInput(body.customShares, input.currency)
      participantIds = idsInput(assignedShares.map(share => share.userId))
      checkCustomShares(BigInt(input.amount), participantIds, assignedShares)
    } else participantIds = idsInput(body.participantIds)
  })
}

function validateExpenseUpdate(round: ExpenseUpdateRow, userId: string, expectedVersion: unknown) {
  if (!round.id || !round.expense) throw missing()
  state(round, 'RECORDING')
  if (!round.is_creator && (!round.active_ids.includes(userId) || round.expense.author_id !== userId)) {
    throw new AppError(403, 'forbidden', '지출 작성자 또는 회차 생성자만 수정할 수 있어요')
  }
  version(round, expectedVersion)
}

export async function saveExpense(access: Identity, key: string, roundId: string, body: ExpenseRequestDTO | Record<string, unknown>, expenseId?: string, captureAudience?: (audience: { groupId: string; userIds: string[] }) => void) {
  if (!expenseId) return createExpense(access, key, roundId, body, captureAudience)
  return withDatabaseConnection(async (client, discardConnection) => {
    const userId = (await requireAccount(client, access)).id
    const digest = mutationDigest(key, { roundId, expenseId, ...body })
    const round = (await repository.findExpenseUpdate(client, roundId, expenseId, userId, key)).rows[0]
    const replay = mutationResult<MutationResult>(round, digest)
    if (replay) return replay
    validateExpenseUpdate(round, userId, body.expectedVersion)
    const previous = round.expense!
    const input = expenseInput(round, body, previous)
    validateCurrencyTotals(round.totals, input, previous)
    const maximum = minorLimit(MAX_ROUND_TOTAL_MAJOR, input.currency)
    const amounts = input.participantIds.map(id => input.assignedShares.find(share => share.userId === id)?.assignedAmountMinor ?? null)
    return withWriteLock(client, discardConnection, async () => {
      const result = await repository.updateExpense(client, expenseId, roundId, userId, key, digest, input, amounts, round.version, maximum.toString(), nowSeconds())
      if (!result) {
        // A concurrent winner may have committed this same key after our SELECT.
        const current = (await repository.findExpenseUpdate(client, roundId, expenseId, userId, key)).rows[0]
        const replay = mutationResult<MutationResult>(current, digest)
        if (replay) return replay
        validateExpenseUpdate(current, userId, body.expectedVersion)
        throw new AppError(409, 'stale_round', '다른 변경이 먼저 저장됐어요. 최신 내역을 확인해 주세요')
      }
      captureAudience?.({ groupId: round.group_id, userIds: round.user_ids })
      return result
    })
  })
}

function validateEditableExpense(round: Omit<ExpenseDeletionRow, 'actor_active' | 'user_ids' | 'object_keys' | 'request_digest' | 'response_metadata' | 'deleted'>, userId: string, expectedVersion: unknown) {
  if (!round.id || !round.expense_id) throw missing()
  state(round, 'RECORDING')
  if (!round.is_creator && (round.viewer_excluded_at !== null || round.author_id !== userId)) {
    throw new AppError(403, 'forbidden', '지출 작성자 또는 회차 생성자만 수정할 수 있어요')
  }
  version(round, expectedVersion)
}

export async function deleteExpense(access: Identity, key: string, roundId: string, expenseId: string, body: VersionRequestDTO | Record<string, unknown>, captureAudience?: (audience: { groupId: string; userIds: string[] }) => void) {
  let userId: string, digest: string, round: ExpenseDeletionRow, replay: MutationResult | null
  let audience: { groupId: string; userIds: string[] } | undefined
  let objectKeys: string[] = []
  const result = await withWriteTransaction(async client => {
    if (replay) return replay
    const current = await repository.deleteExpense(client, roundId, expenseId, userId, key, digest, round.version, nowSeconds())
    if (!current.actor_active) throw new AppError(401, 'unauthorized', '로그인이 필요합니다')
    const result = mutationResult<MutationResult>(current, digest)
    if (!result) {
      validateEditableExpense(current, userId, body.expectedVersion)
      throw new AppError(409, 'stale_round', '다른 변경이 먼저 저장됐어요. 최신 내역을 확인해 주세요')
    }
    if (current.deleted) {
      objectKeys = current.object_keys
      audience = { groupId: current.group_id, userIds: current.user_ids }
    }
    return result
  }, async client => {
    userId = (await requireAccount(client, access)).id
    onlyKeys(body, ['expectedVersion'])
    digest = mutationDigest(key, { roundId, expenseId, ...body })
    round = (await repository.findExpenseDeletion(client, roundId, expenseId, userId, key)).rows[0]
    replay = mutationResult<MutationResult>(round, digest)
    if (!replay) validateEditableExpense(round, userId, body.expectedVersion)
  })
  await cleanupReceiptObjects(objectKeys)
  if (audience) captureAudience?.(audience)
  return result
}

async function cleanupReceiptObjects(keys: string[]) {
  for (const key of keys) {
    try { await deleteReceiptObject(key) }
    catch (error) { console.error('receipt_cleanup_failed', key, error) }
  }
}

async function exclusions(client: Database, round: RoundRow, targetId: string): Promise<ExclusionCheck> {
  const { rows: [member] } = await repository.findExclusionExpenses(client, round.id, targetId)
  if (!member) throw missing()
  return exclusionCheck(round, targetId, member)
}

function exclusionCheck(round: RoundRow, targetId: string, member: Pick<MemberExclusionRow, 'excluded_at' | 'member_count' | 'expenses'>): ExclusionCheck {
  const rows = member.expenses
  const reason = round.creator_id === targetId ? 'round_creator_cannot_leave' : member.excluded_at !== null ? 'already_excluded' : !['RECORDING', 'CONFIRMED'].includes(round.status) ? 'invalid_round_state' : rows.length ? 'member_exclusion_blocked' : Number(member.member_count) <= 2 ? 'minimum_participants' : null
  return { allowed: reason === null, reason, expenses: rows.map(e => ({ id: e.id, description: e.description, currency: e.currency, amountMinor: e.amount_minor, authorId: e.author_id, authorName: e.author_name, reason: e.reason })) }
}

export async function checkExclusion(access: Identity, roundId: string, userId: string) {
  return withDatabaseConnection(async client => {
    const account = await requireAccount(client, access), round = await roundFor(client, roundId, account.id)
    creator(round)
    return exclusions(client, round, userId)
  })
}

export async function excludeMember(access: Identity, key: string, roundId: string, targetId: string, body: VersionRequestDTO | Record<string, unknown>, captureAudience?: (audience: { groupId: string; userIds: string[]; groupUserIds: string[] }) => void) {
  return withDatabaseConnection(async client => {
    const account = await requireAccount(client, access)
    onlyKeys(body, ['expectedVersion'])
    mutationDigest(key, { roundId, targetId, ...body })
    const { rows: [round] } = await repository.findMemberExclusion(client, roundId, targetId, account.id)
    if (!round) throw missing()
    creator(round)
    if (!round.target_id || round.excluded_at !== null) throw missing()
    state(round, 'RECORDING')
    version(round, body.expectedVersion)
    const check = exclusionCheck(round, targetId, round)
    if (!check.allowed) throw new AppError(409, check.reason === 'minimum_participants' ? check.reason : 'member_exclusion_blocked', check.expenses.length ? '해당 사용자와 연관된 정산이 있습니다.' : check.reason === 'minimum_participants' ? '회차는 최소 2명이어야 합니다' : '해당 사용자는 제외할 수 없어요', check)
    const result = await repository.excludeMember(client, roundId, targetId, account.id, round.version, nowSeconds())
    if (!result) throw new AppError(409, 'stale_round', '다른 변경이 먼저 저장됐어요. 최신 내역을 확인해 주세요')
    captureAudience?.({ groupId: round.group_id, userIds: round.user_ids, groupUserIds: round.group_user_ids })
    return result
  })
}

async function validatedExpenses(client: Database, roundId: string) {
  const members = await membersFor(client, roundId), items = await settlementExpensesFor(client, roundId)
  return validateExpenses(items, members)
}

function validateExpenses(items: Awaited<ReturnType<typeof settlementExpensesFor>>, members: RoundMember[]) {
  const active = members.filter(m => m.excludedAt === null).map(m => m.userId).sort()
  if (active.length < 2) throw new AppError(409, 'minimum_participants', '회차는 최소 2명이어야 합니다')
  if (!items.length) throw new AppError(409, 'empty_expenses', '지출 내역이 없습니다')
  const totals = new Map<Currency, bigint>()
  for (const expense of items) {
    if (!expense.participantIds.length || expense.participantIds.some(id => !active.includes(id)) || !members.some(m => m.userId === expense.payerId) || (expense.splitMode === 'ALL' && JSON.stringify(expense.participantIds.slice().sort()) !== JSON.stringify(active))) {
      badInput('invalid_participants', '지출 참여 내역을 다시 확인해 주세요')
    }
    const currency = requireCurrency(expense.currency)
    const amount = BigInt(expense.amountMinor)
    if (amount <= 0n) badInput('invalid_amount')
    if (expense.splitMode === 'CUSTOM') checkCustomShares(amount, expense.participantIds, expense.shares)
    if (amount > minorLimit(MAX_EXPENSE_MAJOR, currency)) badInput('expense_amount_limit_exceeded', `지출 금액은 ${formatMoney(minorLimit(MAX_EXPENSE_MAJOR, currency).toString(), currency)} 이하여야 해요`)
    totals.set(currency, (totals.get(currency) ?? 0n) + amount)
  }
  if (totals.size > MAX_ROUND_CURRENCIES) badInput('round_currency_limit_exceeded', '한 회차에는 최대 5개 통화를 기록할 수 있어요')
  for (const [currency, total] of totals) if (total > minorLimit(MAX_ROUND_TOTAL_MAJOR, currency)) badInput('round_total_limit_exceeded', `통화별 전체 지출은 ${formatMoney(minorLimit(MAX_ROUND_TOTAL_MAJOR, currency).toString(), currency)} 이하여야 해요`)
  return { items, members }
}

async function finalize(client: Database, roundId: string, { items, members }: Awaited<ReturnType<typeof validatedExpenses>>) {
  const result = finalizeCurrencySettlement(items, members.map(m => m.userId))
  for (const share of result.shares) await repository.saveFinalShare(client, share.expenseId, share.userId, share.amountMinor, share.receivedRemainder)
  for (const balance of result.balances) await repository.insertBalance(client, roundId, balance.userId, balance.paidMinor, balance.burdenMinor, balance.balanceMinor, balance.currency)
  for (const transfer of result.transfers) await repository.insertTransfer(client, roundId, transfer.senderId, transfer.receiverId, transfer.amountMinor, transfer.currency)
  await repository.finalizeRound(client, roundId, nowSeconds())
}

function validateRoundConfirmation(round: RoundConfirmationRow, expectedVersion: unknown) {
  if (!round.id) throw missing()
  creator(round)
  version(round, expectedVersion)
  state(round, 'RECORDING')
  validateExpenses(round.expenses.map(settlementExpenseDetails), round.members.map(memberDetails))
}

async function confirmRound(access: Identity, key: string, roundId: string, body: VersionRequestDTO | Record<string, unknown>, captureAudience?: (audience: { groupId: string; userIds: string[] }) => void): Promise<MutationResult> {
  let userId: string, digest: string, round: RoundConfirmationRow, replay: MutationResult | null
  return withWriteTransaction(async client => {
    if (replay) return replay
    const current = await repository.confirmRound(client, roundId, userId, key, digest, round.version, nowSeconds())
    if (!current.actor_active) throw new AppError(401, 'unauthorized', '로그인이 필요합니다')
    const result = mutationResult<MutationResult>(current, digest)
    if (!result) {
      validateRoundConfirmation(current, body.expectedVersion)
      throw new AppError(409, 'stale_round', '다른 변경이 먼저 저장됐어요. 최신 내역을 확인해 주세요')
    }
    if (current.confirmed) captureAudience?.({ groupId: current.group_id, userIds: current.user_ids })
    return result
  }, async client => {
    const { rows: [current] } = await repository.findRoundConfirmation(client, roundId, userId, key)
    round = current
    replay = mutationResult<MutationResult>(round, digest)
    if (!replay) validateRoundConfirmation(round, body.expectedVersion)
  }, async client => {
    userId = (await requireAccount(client, access)).id
    onlyKeys(body, ['expectedVersion'])
    digest = mutationDigest(key, { roundId, ...body })
  })
}

export async function roundCommand(access: Identity, key: string, roundId: string, action: string, body: VersionRequestDTO | Record<string, unknown>, captureAudience?: (audience: { groupId: string; userIds: string[] }) => void): Promise<MutationResult> {
  if (action === 'confirm') return confirmRound(access, key, roundId, body, captureAudience)
  if (action === 'force-complete') return withDatabaseConnection(async client => {
    const account = await requireAccount(client, access)
    onlyKeys(body, ['expectedVersion'])
    const digest = mutationDigest(key, { roundId, ...body })
    const { rows: [round] } = await repository.findRoundForceCompletion(client, roundId, account.id, key)
    const replay = mutationResult<MutationResult>(round, digest)
    if (replay) return replay
    if (!round.id) throw missing()
    creator(round)
    version(round, body.expectedVersion)
    state(round, 'LOCKED')
    if (round.finalized_at === null) throw new AppError(409, 'invalid_round_state', '나머지 배분을 먼저 완료해 주세요')
    const current = await repository.forceCompleteRound(client, roundId, account.id, key, digest, round.version, nowSeconds()).catch(error => {
      if (error?.code === '23505' && error.constraint === 'mutation_requests_pkey') {
        throw new AppError(409, 'idempotency_conflict', '같은 요청 키로 다른 내용을 저장할 수 없어요')
      }
      throw error
    })
    if (!current.actor_active) throw new AppError(401, 'unauthorized', '로그인이 필요합니다')
    const result = mutationResult<MutationResult>(current, digest)
    if (!result) {
      if (!current.id) throw missing()
      creator(current)
      version(current, body.expectedVersion)
      state(current, 'LOCKED')
      if (current.finalized_at === null) throw new AppError(409, 'invalid_round_state', '나머지 배분을 먼저 완료해 주세요')
      throw new AppError(409, 'stale_round', '다른 변경이 먼저 저장됐어요. 최신 내역을 확인해 주세요')
    }
    if (current.completed) captureAudience?.({ groupId: round.group_id, userIds: round.user_ids })
    return result
  })
  if (action === 'complete') return withDatabaseConnection(async client => {
    const account = await requireAccount(client, access)
    onlyKeys(body, ['expectedVersion'])
    const digest = mutationDigest(key, { roundId, ...body })
    const expectedVersion = typeof body.expectedVersion === 'number' && Number.isSafeInteger(body.expectedVersion) ? body.expectedVersion : null
    const current = await repository.completeCheckedRound(client, roundId, account.id, key, digest, expectedVersion, nowSeconds())
    if (!current.actor_active) throw new AppError(401, 'unauthorized', '로그인이 필요합니다')
    const result = mutationResult<MutationResult>(current, digest)
    if (!result) {
      if (!current.id) throw missing()
      creator(current)
      version(current, body.expectedVersion)
      state(current, 'LOCKED')
      if (current.finalized_at === null) throw new AppError(409, 'invalid_round_state', '나머지 배분을 먼저 완료해 주세요')
      if (current.pending_count) throw new AppError(409, 'pending_settlement_checks', '모든 수취인이 입금을 확인한 뒤 종료할 수 있어요', { pendingCount: current.pending_count })
      throw new AppError(409, 'stale_round', '다른 변경이 먼저 저장됐어요. 최신 내역을 확인해 주세요')
    }
    if (current.completed) captureAudience?.({ groupId: current.group_id, userIds: current.user_ids })
    return result
  })
  if (action === 'draw') return withDatabaseConnection(async client => {
    const account = await requireAccount(client, access)
    onlyKeys(body, ['expectedVersion'])
    const digest = mutationDigest(key, { roundId, ...body })
    const { rows: [round] } = await repository.findRoundConfirmation(client, roundId, account.id, key, 'draw')
    const replay = mutationResult<MutationResult>(round, digest)
    if (replay) return replay
    if (!round.id) throw missing()
    creator(round)
    let settlement: ReturnType<typeof finalizeCurrencySettlement> | null = null
    if (round.finalized_at === null) {
      version(round, body.expectedVersion)
      state(round, 'LOCKED')
      const { items, members } = validateExpenses(round.expenses.map(settlementExpenseDetails), round.members.map(memberDetails))
      settlement = finalizeCurrencySettlement(items, members.map(member => member.userId), max => randomInt(max))
    }
    const current = await repository.drawRound(client, roundId, account.id, key, digest, round.version, nowSeconds(), settlement)
    if (!current.actor_active) throw new AppError(401, 'unauthorized', '로그인이 필요합니다')
    const result = mutationResult<MutationResult>(current, digest)
    if (!result) {
      if (!current.id) throw missing()
      creator(current)
      state(current, 'LOCKED')
      version(current, body.expectedVersion)
      throw new AppError(409, 'stale_round', '다른 변경이 먼저 저장됐어요. 최신 내역을 확인해 주세요')
    }
    if (current.drawn) captureAudience?.({ groupId: round.group_id, userIds: round.user_ids })
    return result
  })
  if (action === 'reopen') return withDatabaseConnection(async client => {
    const account = await requireAccount(client, access)
    onlyKeys(body, ['expectedVersion'])
    mutationDigest(key, { roundId, ...body })
    const { rows: [round] } = await repository.findRoundReopening(client, roundId, account.id)
    if (!round) throw missing()
    creator(round)
    state(round, 'CONFIRMED')
    version(round, body.expectedVersion)
    const result = await repository.reopenRound(client, roundId, account.id, round.version)
    if (!result) throw new AppError(409, 'stale_round', '다른 변경이 먼저 저장됐어요. 최신 내역을 확인해 주세요')
    captureAudience?.({ groupId: round.group_id, userIds: round.user_ids })
    return result
  })
  if (action === 'cancel') {
    let userId: string
    return withWriteTransaction(async client => {
      onlyKeys(body, ['expectedVersion'])
      const digest = mutationDigest(key, { roundId, ...body })
      const { rows: [round] } = await repository.findRoundCancellation(client, roundId, userId, key)
      const replay = mutationResult<MutationResult>(round, digest)
      if (replay) return replay
      if (!round.id) throw missing()
      creator(round)
      version(round, body.expectedVersion)
      state(round, 'RECORDING')
      if (round.has_expenses) throw new AppError(409, 'round_has_expenses', '지출 기록이 있는 회차는 취소할 수 없어요. 지출을 먼저 삭제해 주세요')
      const result = { id: roundId, roundId }
      await repository.deleteRound(client, roundId, userId, key, digest, result, nowSeconds())
      captureAudience?.({ groupId: round.group_id, userIds: round.user_ids })
      return result
    }, async client => { userId = (await requireAccount(client, access)).id })
  }
  onlyKeys(body, ['expectedVersion'])
  if (action !== 'send') throw missing()
  return domainMutation(access, key, `round.${action}`, { roundId, ...body }, async (client, userId) => {
    const round = await roundFor(client, roundId, userId)
    creator(round)
    version(round, body.expectedVersion)
    const now = nowSeconds()
    if (action === 'send') {
      state(round, 'CONFIRMED')
      const expenses = await validatedExpenses(client, roundId)
      const { rowCount } = await repository.lockRound(client, roundId, now, round.version)
      if (!rowCount) throw new AppError(409, 'stale_round', '다른 변경이 먼저 저장됐어요. 최신 내역을 확인해 주세요')
      const { rows } = await repository.findRemainder(client, roundId)
      if (!rows.length) await finalize(client, roundId, expenses)
      captureAudience?.({ groupId: round.group_id, userIds: expenses.members.map(member => member.userId) })
    }
    return bump(client, roundId, round.version)
  })
}

export async function setSettlementCheck(access: Identity, key: string, roundId: string, body: SettlementCheckRequestDTO | Record<string, unknown>, captureAudience?: (audience: { groupId: string; userIds: string[] }) => void) {
  return withDatabaseConnection(async client => {
    const account = await requireAccount(client, access)
    onlyKeys(body, ['expectedVersion', 'checked', 'senderId', 'currency'])
    if (typeof body.checked !== 'boolean') badInput('invalid_input', '정산 확인 여부를 선택해 주세요')
    if (body.senderId !== undefined && (typeof body.senderId !== 'string' || body.senderId !== body.senderId.trim() || !/^[\w-]{1,128}$/.test(body.senderId))) badInput('invalid_input', '확인할 송금자를 다시 선택해 주세요')
    mutationDigest(key, { roundId, ...body })
    let currency: Currency | undefined
    if (body.currency !== undefined) {
      try { currency = requireCurrency(body.currency) } catch { badInput('unsupported_currency', '지원하는 통화를 선택해 주세요') }
    }
    if (body.senderId !== undefined && !currency) badInput('unsupported_currency', '개별 수취 확인에는 통화가 필요합니다')
    const senderId = body.senderId as string | undefined
    const { rows: [round] } = await repository.findSettlementCheck(client, roundId, account.id)
    if (!round) throw missing()
    version(round, body.expectedVersion)
    state(round, 'LOCKED')
    if (round.finalized_at === null) throw new AppError(409, 'invalid_round_state', '최종 금액이 정해진 뒤 확인할 수 있어요')
    const incoming = round.incoming.filter(transfer => (senderId === undefined || transfer.sender_id === senderId) && (currency === undefined || transfer.currency === currency))
    if (!incoming.length) throw new AppError(403, 'forbidden', '확인할 수 있는 수취 내역이 없어요')
    if (!incoming.some(transfer => (transfer.received_at !== null) !== body.checked)) throw new AppError(404, 'not_found', '변경할 수취 내역이 없어요')
    const { rowCount } = await repository.setReceived(client, roundId, account.id, senderId ?? null, body.checked, nowSeconds(), round.version, currency ?? null)
    if (!rowCount) throw new AppError(404, 'not_found', '변경할 수취 내역이 없어요')
    captureAudience?.({ groupId: round.group_id, userIds: round.user_ids })
    return { id: roundId, roundId, status: round.status, version: round.version }
  })
}

export async function getSettlement(access: Identity, roundId: string): Promise<SettlementDTO> {
  return withDatabaseConnection(async client => {
    const account = await requireAccount(client, access)
    const { rows: [round] } = await repository.findSettlement(client, roundId, account.id)
    if (!round) throw missing()
    const checks = round.confirmations.map(row => ({ userId: row.user_id, displayName: row.display_name_snapshot, profileImageUrl: row.profile_image_url,
      checkedAt: row.checked_at === null ? null : Number(row.checked_at) }))
    const viewerCheck = checks.find(member => member.userId === account.id)
    const checkedCount = checks.filter(member => member.checkedAt !== null).length
    const result: SettlementDTO = { roundId, name: round.name, groupName: round.group_name, status: round.status, version: round.version, isCreator: round.is_creator, finalized: round.finalized_at !== null, balances: [],
      checkedAt: viewerCheck?.checkedAt ?? null, checkRequired: Boolean(viewerCheck), checkedCount, requiredCount: checks.length, allChecked: checkedCount === checks.length,
      confirmations: checks, outgoing: [], incoming: [], sharePath: null }
    if (!result.finalized) return result
    result.balances = round.balances ?? []
    result.sharePath = `/settlements/${roundId}`
    result.outgoing = round.outgoing.map(row => ({ currency: row.currency, receiverId: row.receiver_id, displayName: row.display_name_snapshot, profileImageUrl: row.profile_image_url, amountMinor: row.amount_minor,
      ...(row.currency === 'KRW' ? { account: { bankName: row.bank_name, accountNumber: row.account_number, formattedAccountNumber: row.account_number_formatted, accountHolder: row.account_holder,
        verifiedAt: row.bank_verified_at === null ? null : Number(row.bank_verified_at) } } : {}) }))
    result.incoming = round.incoming.map(row => ({ currency: row.currency, senderId: row.sender_id, displayName: row.display_name_snapshot, profileImageUrl: row.profile_image_url, amountMinor: row.amount_minor,
      receivedAt: row.received_at === null ? null : Number(row.received_at) }))
    return result
  })
}

type ReceiptUpload = { expectedVersion: number; bytes: Uint8Array; type: string; name?: string }
type ReceiptAudience = (audience: { groupId: string; userIds: string[] }) => void

export async function addReceipt(access: Identity, key: string, roundId: string, expenseId: string, ...input:
  [expectedVersion: number, bytes: Uint8Array, type: string, captureAudience?: ReceiptAudience] |
  [readUpload: () => Promise<ReceiptUpload>, captureAudience?: ReceiptAudience]) {
  if (!access) throw new AppError(401, 'unauthorized', '로그인이 필요합니다')
  const account = await withDatabaseConnection(client => requireAccount(client, access))
  const upload: ReceiptUpload = typeof input[0] === 'function' ? await input[0]() : { expectedVersion: input[0], bytes: input[1] as Uint8Array, type: input[2] as string }
  const captureAudience = typeof input[0] === 'function' ? input[1] as ReceiptAudience | undefined : input[3]
  const { expectedVersion, bytes, type } = upload
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) badInput('invalid_version', '회차 버전이 필요합니다')
  const sourceSha256 = createHash('sha256').update(bytes).digest('hex')
  const digest = mutationDigest(key, { roundId, expenseId, expectedVersion, sourceSha256, type })
  const file = await convertReceipt(bytes, type, upload.name)
  const id = randomUUID()
  // Each attempt owns its object so a rejected retry cannot overwrite or delete a saved receipt.
  const objectKey = await putReceipt(`receipts/${account.id}/${id}.avif`, file.content, file.mimeType)
  let retained = false, resolved = false
  try {
    const current = await withDatabaseConnection(client => repository.insertReceipt(client, roundId, expenseId, account.id, key, digest, expectedVersion, id, file.mimeType, file.content.length, file.sha256, objectKey, nowSeconds()))
    resolved = true
    retained = current.inserted
    if (!current.actor_active) throw new AppError(401, 'unauthorized', '로그인이 필요합니다')
    const result = mutationResult<MutationResult>(current, digest)
    if (!result) {
      validateEditableExpense(current, account.id, expectedVersion)
      throw new AppError(409, 'stale_round', '다른 변경이 먼저 저장됐어요. 최신 내역을 확인해 주세요')
    }
    if (current.inserted) captureAudience?.({ groupId: current.group_id, userIds: current.user_ids })
    return result
  } catch (error) {
    // A PostgreSQL statement error rolls back every CTE; a lost response may have committed.
    if (error && typeof error === 'object' && 'code' in error && /^(?:22|23|40|P0)/.test(String(error.code))) resolved = true
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
      throw new AppError(409, 'idempotency_conflict', '같은 요청 키로 다른 내용을 저장할 수 없어요')
    }
    throw error
  } finally {
    if (resolved && !retained) await cleanupReceiptObjects([objectKey])
  }
}

export async function removeReceipt(access: Identity, key: string, roundId: string, expenseId: string, receiptId: string, body: VersionRequestDTO | Record<string, unknown>, captureAudience?: ReceiptAudience) {
  let objectKey: string | null = null
  let audience: Parameters<ReceiptAudience>[0] | undefined
  const result = await withDatabaseConnection(async client => {
    const account = await requireAccount(client, access)
    onlyKeys(body, ['expectedVersion'])
    const digest = mutationDigest(key, { roundId, expenseId, receiptId, ...body })
    const round = (await repository.findReceiptDeletion(client, roundId, expenseId, receiptId, account.id, key)).rows[0]
    const replay = mutationResult<MutationResult>(round, digest)
    if (replay) return replay
    validateEditableExpense(round, account.id, body.expectedVersion)
    if (!round.receipt_id) throw missing()
    const current = await repository.deleteReceipt(client, roundId, expenseId, receiptId, account.id, key, digest, round.version, nowSeconds()).catch(error => {
      if (error && typeof error === 'object' && error.code === '23505') {
        throw new AppError(409, 'idempotency_conflict', '같은 요청 키로 다른 내용을 저장할 수 없어요')
      }
      throw error
    })
    if (!current.actor_active) throw new AppError(401, 'unauthorized', '로그인이 필요합니다')
    let result = mutationResult<MutationResult>(current, digest)
    if (!result) {
      // A competing autocommit may finish after this statement's snapshot was taken.
      const latest = (await repository.findReceiptDeletion(client, roundId, expenseId, receiptId, account.id, key)).rows[0]
      if (!latest.actor_active) throw new AppError(401, 'unauthorized', '로그인이 필요합니다')
      result = mutationResult<MutationResult>(latest, digest)
      if (!result) {
        validateEditableExpense(latest, account.id, body.expectedVersion)
        if (!latest.receipt_id) throw missing()
        throw new AppError(409, 'stale_round', '다른 변경이 먼저 저장됐어요. 최신 내역을 확인해 주세요')
      }
    }
    if (current.deleted) {
      objectKey = current.object_key
      audience = { groupId: current.group_id, userIds: current.user_ids }
    }
    return result
  })
  if (objectKey) await cleanupReceiptObjects([objectKey])
  if (audience) captureAudience?.(audience)
  return result
}

export async function getReceipt(access: Identity, receiptId: string) {
  const receipt = await withDatabaseConnection(async client => {
    const account = await requireAccount(client, access)
    const { rows } = await repository.findReceipt(client, receiptId, account.id)
    if (!rows[0]) throw missing()
    return rows[0]
  })
  const content = receipt.object_key ? await readReceipt(receipt.object_key) : receipt.content
  if (!content) throw missing()
  return { mimeType: receipt.mime_type, content }
}

export function getBankSettlementAudience(userId: string) {
  return withDatabaseConnection(client => repository.findBankSettlementAudience(client, userId))
}
