import 'server-only'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import { requireAccount } from '../../../../Global/Auth/Backend'
import { AppError, badInput, withDatabaseConnection, withWriteLock, withReadTransaction, replayMutation, deleteReceiptObject, putReceipt, readReceipt, convertReceipt, type Database, domainMutation, idsInput, nowSeconds, onlyKeys, pageOf, pagination, textInput, type Identity } from '../../../../Global/Util/Backend'
import { formatMoney, MAX_EXPENSE_MAJOR, MAX_ROUND_TOTAL_MAJOR, minorLimit, parseAmount, requireCurrency, type Currency, type CreateRoundRequestDTO, type ExpenseRequestDTO, type VersionRequestDTO, type SettlementCheckRequestDTO } from '../../Shared'
import { calculateBase, finalizeSettlement, previewSettlement, validateCustomShares } from '../../Shared'
import type { ExclusionCheck, Expense, MutationResult, RoundDetail, RoundMember, RoundStatus, RoundSummary, SettlementDTO, SettlementTransfer } from '../../Shared'

import type { RoundRow, MemberRow, ExpenseRow, ShareRow, ReceiptRow } from '../DAO/SettleDAO'
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

async function bump(client: Database, id: string): Promise<MutationResult> {
  const { rows } = await repository.bumpRound(client, id)
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
    id: row.id, authorId: row.author_id, payerId: row.payer_id, description: row.description, amountMinor: row.amount_minor,
    splitMode: row.split_mode, participantIds: part.map(s => s.user_id), baseShareMinor: base ? row.base_share_minor ?? base.base.toString() : null, remainderUnits: base ? row.remainder_units ?? base.remainder : 0,
    shares: part.map(s => ({ userId: s.user_id, assignedAmountMinor: s.assigned_amount_minor, amountMinor: s.final_amount_minor, receivedRemainder: s.received_remainder })),
    receipts: receipts.map(r => ({ id: r.id, mimeType: r.mime_type, byteSize: r.byte_size })),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  }
}

async function settlementExpensesFor(client: Database, roundId: string): Promise<(Pick<Expense, 'id' | 'payerId' | 'amountMinor' | 'splitMode' | 'participantIds'> & { shares: Pick<Expense['shares'][number], 'userId' | 'assignedAmountMinor'>[] })[]> {
  const { rows } = await repository.findSettlementExpenses(client, roundId)
  return rows.map(row => ({ id: row.id, payerId: row.payer_id, amountMinor: row.amount_minor, splitMode: row.split_mode, participantIds: row.participant_ids, shares: row.shares ?? [] }))
}

async function settlementChecksFor(client: Database, roundId: string) {
  const { rows } = await repository.findSettlementChecks(client, roundId)
  return rows.map(row => ({ userId: String(row.user_id), displayName: String(row.display_name_snapshot), profileImageUrl: row.profile_image_url as string | null,
    checkedAt: row.checked_at === null ? null : Number(row.checked_at) }))
}

function summary(row: RoundRow): RoundSummary {
  return {
    id: row.id, groupId: row.group_id, groupName: row.group_name, name: row.name, currency: row.currency,
    status: row.status, version: row.version, createdAt: Number(row.created_at),
    finalizedAt: row.finalized_at === null ? null : Number(row.finalized_at), completedAt: row.completed_at === null ? null : Number(row.completed_at),
    balanceMinor: row.balance_minor ?? null, totalMinor: row.total_minor ?? '0', memberCount: Number(row.member_count ?? 0),
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
    let transfers: SettlementTransfer[] = [], pendingRemainderMinor = '0'
    if (round.finalized_at === null) {
      const allExpenses = round.settlement_expenses.map(row => ({ id: row.id, payerId: row.payer_id, amountMinor: row.amount_minor, splitMode: row.split_mode, participantIds: row.participant_ids, shares: row.shares ?? [] }))
      if (allExpenses.length) ({ transfers, pendingRemainderMinor } = previewSettlement(allExpenses, members.map(member => member.userId)))
    } else {
      transfers = round.transfers.map(row => ({ senderId: row.sender_id, receiverId: row.receiver_id, amountMinor: row.amount_minor }))
    }
    transfers = transfers.filter(transfer => transfer.senderId === account.id || transfer.receiverId === account.id)
    return {
      ...summary({ ...round, member_count: members.filter(m => m.excludedAt === null).length }),
      creatorId: round.creator_id, groupCreatorId: round.group_creator_id, isCreator: round.is_creator, members, expenses: expenses.items, expensesNextCursor: expenses.nextCursor,
      transfers, pendingRemainderMinor,
    }
  })
}

export async function createRound(access: Identity, key: string, groupId: string, body: CreateRoundRequestDTO | Record<string, unknown>, captureAudience?: (userIds: string[]) => void) {
  return withDatabaseConnection((client, discardConnection) => withWriteLock(client, discardConnection, async () => {
    const account = await requireAccount(client, access)
    onlyKeys(body, ['name', 'currency', 'participantIds'])
    const name = textInput(body.name, 100), ids = idsInput(body.participantIds)
    let currency: Currency
    try { currency = requireCurrency(body.currency) } catch { badInput('unsupported_currency', '지원하는 회차 통화를 선택해 주세요') }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) badInput('invalid_request_key', 'UUIDv7 회차 생성 ticket이 필요합니다')
    if (ids.length < 2 || !ids.includes(account.id)) throw new AppError(409, 'minimum_participants', '회차 생성자를 포함해 최소 2명을 선택해 주세요')
    const id = key.toLowerCase()
    try {
      const result = await repository.insertRound(client, id, groupId, account.id, name, currency, nowSeconds(), ids)
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

async function expenseFor(client: Database, roundId: string, expenseId: string): Promise<ExpenseRow> {
  const { rows } = await repository.findExpense(client, expenseId, roundId)
  if (!rows[0]) throw missing()
  return rows[0]
}

async function editable(client: Database, round: RoundRow, userId: string, expense?: ExpenseRow) {
  state(round, 'RECORDING')
  if (round.is_creator) return
  const { rows } = await repository.findActiveMember(client, round.id, userId)
  if (!rows.length || (expense && expense.author_id !== userId)) throw new AppError(403, 'forbidden', '지출 작성자 또는 회차 생성자만 수정할 수 있어요')
}

async function expenseInput(client: Database, round: RoundRow, body: ExpenseRequestDTO | Record<string, unknown>, previous?: ExpenseRow): Promise<{ description: string; amount: string; payerId: string; splitMode: Expense['splitMode']; participantIds: string[]; assignedShares: { userId: string; assignedAmountMinor: string | null }[] }> {
  onlyKeys(body, ['description', 'amount', 'payerId', 'splitMode', 'participantIds', 'customShares', 'expectedVersion'])
  const description = textInput(body.description === undefined ? previous?.description : body.description, 500)
  const currency = round.currency as Currency
  let amount: bigint
  try { amount = body.amount === undefined && previous ? BigInt(previous.amount_minor) : parseAmount(body.amount, currency) } catch { badInput('invalid_amount', '통화에 맞는 양의 금액을 정확히 입력해 주세요') }
  const maximum = minorLimit(MAX_EXPENSE_MAJOR, currency)
  if (amount > maximum) badInput('expense_amount_limit_exceeded', `지출 금액은 ${formatMoney(maximum.toString(), currency)} 이하여야 해요`)
  const payerId = textInput(body.payerId === undefined ? previous?.payer_id : body.payerId, 128)
  const splitMode = body.splitMode === undefined ? previous?.split_mode : body.splitMode
  if (splitMode !== 'ALL' && splitMode !== 'SELECTED' && splitMode !== 'CUSTOM') badInput('invalid_participants', '분배 방식을 선택해 주세요')
  if (splitMode !== 'CUSTOM' && body.customShares !== undefined) badInput('invalid_input', '개별 부담금은 개별 항목 분배에서만 입력해 주세요')
  const members = await membersFor(client, round.id), active = members.filter(m => m.excludedAt === null).map(m => m.userId)
  if (!active.includes(payerId) && payerId !== previous?.payer_id) badInput('invalid_participants', '결제자는 이번 회차 참여자여야 합니다')
  let participantIds: string[]
  let assignedShares: { userId: string; assignedAmountMinor: string | null }[] = []
  if (splitMode === 'ALL') {
    if (body.participantIds !== undefined) badInput('invalid_participants', '전체 분배의 참여자는 서버에서 결정합니다')
    participantIds = active
  } else if (splitMode === 'CUSTOM') {
    if (body.participantIds !== undefined) badInput('invalid_input', '개별 항목 분배의 부담자는 부담금과 함께 선택해 주세요')
    if (body.customShares === undefined && previous?.split_mode === 'CUSTOM') {
      const { rows } = await repository.findAssignedShares(client, previous.id)
      assignedShares = rows.map(share => ({ userId: share.user_id, assignedAmountMinor: share.assigned_amount_minor }))
    } else {
      if (!Array.isArray(body.customShares) || !body.customShares.length || body.customShares.length > active.length) badInput('invalid_participants', '부담자와 부담금을 선택해 주세요')
      assignedShares = body.customShares.map(share => {
        if (!share || typeof share !== 'object' || Array.isArray(share)) badInput('invalid_participants', '부담자와 부담금을 선택해 주세요')
        onlyKeys(share, ['userId', 'amount'])
        let assignedAmount: bigint
        try { assignedAmount = parseAmount(share.amount, currency) } catch { badInput('invalid_amount', '통화에 맞는 양의 부담금을 정확히 입력해 주세요') }
        return { userId: share.userId, assignedAmountMinor: assignedAmount.toString() }
      })
    }
    participantIds = idsInput(assignedShares.map(share => share.userId))
    if (participantIds.some(id => !active.includes(id))) badInput('invalid_participants', '부담자는 제외되지 않은 회차 참여자여야 합니다')
    checkCustomShares(amount, participantIds, assignedShares)
  } else {
    const previousShares = previous && body.participantIds === undefined ? await repository.findShareMembers(client, previous.id) : null
    participantIds = idsInput(body.participantIds === undefined ? previousShares?.rows.map(s => s.user_id) : body.participantIds)
    if (participantIds.some(id => !active.includes(id))) badInput('invalid_participants', '부담자는 제외되지 않은 회차 참여자여야 합니다')
  }
  if (!participantIds.length) badInput('invalid_participants', '부담자가 필요합니다')
  return { description, amount: amount.toString(), payerId, splitMode, participantIds, assignedShares }
}

function checkCustomShares(amount: bigint, participantIds: string[], shares: { userId: string; assignedAmountMinor: string | null }[]) {
  try { validateCustomShares(amount, participantIds, shares) }
  catch (error) {
    const code = error instanceof Error ? error.message : 'invalid_amount'
    badInput(code, code === 'custom_share_total_mismatch' ? '부담금 합계가 총 금액과 일치해야 해요' : '개별 부담자와 부담금을 다시 확인해 주세요')
  }
}

async function storeShares(client: Database, expenseId: string, roundId: string, ids: string[], assignedShares: { userId: string; assignedAmountMinor: string | null }[]) {
  await repository.deleteShares(client, expenseId)
  const amounts = ids.map(id => assignedShares.find(share => share.userId === id)?.assignedAmountMinor ?? null)
  await repository.insertShares(client, expenseId, roundId, ids, amounts)
}

export async function saveExpense(access: Identity, key: string, roundId: string, body: ExpenseRequestDTO | Record<string, unknown>, expenseId?: string) {
  return domainMutation(access, key, expenseId ? 'expense.update' : 'expense.create', { roundId, expenseId, ...body }, async (client, userId) => {
    const round = await roundFor(client, roundId, userId)
    const previous = expenseId ? await expenseFor(client, roundId, expenseId) : undefined
    await editable(client, round, userId, previous)
    version(round, body.expectedVersion)
    const input = await expenseInput(client, round, body, previous), now = nowSeconds(), id = expenseId ?? randomUUID()
    const { rows: totals } = await repository.findTotal(client, roundId)
    const nextTotal = BigInt(totals[0].total_minor) - BigInt(previous?.amount_minor ?? 0) + BigInt(input.amount)
    const maximum = minorLimit(MAX_ROUND_TOTAL_MAJOR, round.currency as Currency)
    if (nextTotal > maximum) badInput('round_total_limit_exceeded', `회차 전체 지출은 ${formatMoney(maximum.toString(), round.currency as Currency)} 이하여야 해요`)
    if (previous) {
      await repository.updateExpense(client, id, input.description, input.amount, input.payerId, input.splitMode, now, userId)
    } else {
      await repository.insertExpense(client, id, roundId, userId, input.payerId, input.description, input.amount, input.splitMode, now)
    }
    await storeShares(client, id, roundId, input.participantIds, input.assignedShares)
    return { ...await bump(client, roundId), id }
  })
}

export async function deleteExpense(access: Identity, key: string, roundId: string, expenseId: string, body: VersionRequestDTO | Record<string, unknown>) {
  onlyKeys(body, ['expectedVersion'])
  let objectKeys: string[] = []
  const result = await domainMutation(access, key, 'expense.delete', { roundId, expenseId, ...body }, async (client, userId) => {
    const round = await roundFor(client, roundId, userId), expense = await expenseFor(client, roundId, expenseId)
    await editable(client, round, userId, expense)
    version(round, body.expectedVersion)
    objectKeys = (await repository.findExpenseObjects(client, expenseId)).rows.map(row => row.object_key)
    await repository.deleteExpense(client, expenseId)
    return { ...await bump(client, roundId), id: expenseId }
  })
  await cleanupReceiptObjects(objectKeys)
  return result
}

async function cleanupReceiptObjects(keys: string[]) {
  for (const key of keys) {
    try { await deleteReceiptObject(key) }
    catch (error) { console.error('receipt_cleanup_failed', key, error) }
  }
}

async function exclusions(client: Database, round: RoundRow, targetId: string): Promise<ExclusionCheck> {
  const members = await membersFor(client, round.id)
  const member = members.find(m => m.userId === targetId)
  if (!member) throw missing()
  const { rows } = await repository.findExclusionExpenses(client, round.id, targetId)
  const reason = round.creator_id === targetId ? 'round_creator_cannot_leave' : member.excludedAt !== null ? 'already_excluded' : !['RECORDING', 'CONFIRMED'].includes(round.status) ? 'invalid_round_state' : rows.length ? 'member_exclusion_blocked' : members.filter(m => m.excludedAt === null).length <= 2 ? 'minimum_participants' : null
  return { allowed: reason === null, reason, expenses: rows.map(e => ({ id: e.id, description: e.description, amountMinor: e.amount_minor, authorId: e.author_id, authorName: e.author_name, reason: e.reason })) }
}

export async function checkExclusion(access: Identity, roundId: string, userId: string) {
  return withReadTransaction(async client => {
    const account = await requireAccount(client, access), round = await roundFor(client, roundId, account.id)
    creator(round)
    return exclusions(client, round, userId)
  })
}

export async function excludeMember(access: Identity, key: string, roundId: string, targetId: string, body: VersionRequestDTO | Record<string, unknown>) {
  onlyKeys(body, ['expectedVersion'])
  return domainMutation(access, key, 'member.exclude', { roundId, targetId, ...body }, async (client, userId) => {
    const round = await roundFor(client, roundId, userId)
    creator(round)
    state(round, 'RECORDING')
    version(round, body.expectedVersion)
    const check = await exclusions(client, round, targetId)
    if (!check.allowed) throw new AppError(409, check.reason === 'minimum_participants' ? check.reason : 'member_exclusion_blocked', check.expenses.length ? '해당 사용자와 연관된 정산이 있습니다.' : check.reason === 'minimum_participants' ? '회차는 최소 2명이어야 합니다' : '해당 사용자는 제외할 수 없어요', check)
    await repository.excludeMember(client, roundId, targetId, nowSeconds())
    await repository.removeAllShareMember(client, roundId, targetId)
    return bump(client, roundId)
  })
}

async function validatedExpenses(client: Database, roundId: string, currency: Currency) {
  const members = await membersFor(client, roundId), active = members.filter(m => m.excludedAt === null).map(m => m.userId).sort()
  if (active.length < 2) throw new AppError(409, 'minimum_participants', '회차는 최소 2명이어야 합니다')
  const items = await settlementExpensesFor(client, roundId)
  if (!items.length) throw new AppError(409, 'empty_expenses', '지출 내역이 없습니다')
  let total = 0n
  for (const expense of items) {
    if (!expense.participantIds.length || expense.participantIds.some(id => !active.includes(id)) || !members.some(m => m.userId === expense.payerId) || (expense.splitMode === 'ALL' && JSON.stringify(expense.participantIds.slice().sort()) !== JSON.stringify(active))) {
      badInput('invalid_participants', '지출 참여 내역을 다시 확인해 주세요')
    }
    const amount = BigInt(expense.amountMinor)
    if (amount <= 0n) badInput('invalid_amount')
    if (expense.splitMode === 'CUSTOM') checkCustomShares(amount, expense.participantIds, expense.shares)
    if (amount > minorLimit(MAX_EXPENSE_MAJOR, currency)) badInput('expense_amount_limit_exceeded', `지출 금액은 ${formatMoney(minorLimit(MAX_EXPENSE_MAJOR, currency).toString(), currency)} 이하여야 해요`)
    total += amount
  }
  if (total > minorLimit(MAX_ROUND_TOTAL_MAJOR, currency)) badInput('round_total_limit_exceeded', `회차 전체 지출은 ${formatMoney(minorLimit(MAX_ROUND_TOTAL_MAJOR, currency).toString(), currency)} 이하여야 해요`)
  return { items, members }
}

async function finalize(client: Database, roundId: string, currency: Currency, draw: boolean) {
  const { items, members } = await validatedExpenses(client, roundId, currency)
  const result = finalizeSettlement(items, members.map(m => m.userId), draw ? max => randomInt(max) : undefined)
  for (const share of result.shares) await repository.saveFinalShare(client, share.expenseId, share.userId, share.amountMinor, share.receivedRemainder)
  for (const balance of result.balances) await repository.insertBalance(client, roundId, balance.userId, balance.paidMinor, balance.burdenMinor, balance.balanceMinor)
  for (const transfer of result.transfers) await repository.insertTransfer(client, roundId, transfer.senderId, transfer.receiverId, transfer.amountMinor)
  await repository.finalizeRound(client, roundId, nowSeconds())
}

export async function roundCommand(access: Identity, key: string, roundId: string, action: string, body: VersionRequestDTO | Record<string, unknown>) {
  onlyKeys(body, ['expectedVersion'])
  if (!['confirm', 'reopen', 'send', 'draw', 'complete', 'force-complete', 'cancel'].includes(action)) throw missing()
  let objectKeys: string[] = []
  const result = await domainMutation(access, key, `round.${action}`, { roundId, ...body }, async (client, userId) => {
    const round = await roundFor(client, roundId, userId)
    creator(round)
    if (action === 'draw' && round.finalized_at !== null) return { id: roundId, roundId, status: round.status, version: round.version }
    version(round, body.expectedVersion)
    const now = nowSeconds()
    if (action === 'confirm') {
      state(round, 'RECORDING')
      const { items } = await validatedExpenses(client, roundId, round.currency as Currency)
      for (const expense of items) {
        if (expense.splitMode === 'CUSTOM') continue
        const base = calculateBase(BigInt(expense.amountMinor), expense.participantIds.length)
        await repository.saveBaseShare(client, expense.id, base.base.toString(), base.remainder)
      }
      await repository.confirmRound(client, roundId, now)
    } else if (action === 'reopen') {
      state(round, 'CONFIRMED')
      await repository.clearBaseShares(client, roundId)
      await repository.reopenRound(client, roundId)
    } else if (action === 'send') {
      state(round, 'CONFIRMED')
      await validatedExpenses(client, roundId, round.currency as Currency)
      await repository.lockRound(client, roundId, now)
      const { rows } = await repository.findRemainder(client, roundId)
      if (!rows.length) await finalize(client, roundId, round.currency as Currency, false)
    } else if (action === 'draw') {
      state(round, 'LOCKED')
      await finalize(client, roundId, round.currency as Currency, true)
    } else if (action === 'complete' || action === 'force-complete') {
      state(round, 'LOCKED')
      if (round.finalized_at === null) throw new AppError(409, 'invalid_round_state', '나머지 배분을 먼저 완료해 주세요')
      if (action === 'complete') {
        const { rows } = await repository.countPendingTransfers(client, roundId)
        if (rows[0].count) throw new AppError(409, 'pending_settlement_checks', '모든 수취인이 입금을 확인한 뒤 종료할 수 있어요', { pendingCount: rows[0].count })
      }
      await repository.completeRound(client, roundId, now)
    } else {
      state(round, 'RECORDING')
      objectKeys = (await repository.findRoundObjects(client, roundId)).rows.map(row => row.object_key)
      await repository.deleteRound(client, roundId)
      return { id: roundId, roundId }
    }
    return bump(client, roundId)
  })
  await cleanupReceiptObjects(objectKeys)
  return result
}

export async function setSettlementCheck(access: Identity, key: string, roundId: string, body: SettlementCheckRequestDTO | Record<string, unknown>) {
  onlyKeys(body, ['expectedVersion', 'checked', 'senderId'])
  if (typeof body.checked !== 'boolean') badInput('invalid_input', '정산 확인 여부를 선택해 주세요')
  if (body.senderId !== undefined && (typeof body.senderId !== 'string' || body.senderId !== body.senderId.trim() || !/^[\w-]{1,128}$/.test(body.senderId))) badInput('invalid_input', '확인할 송금자를 다시 선택해 주세요')
  const senderId = body.senderId as string | undefined
  return domainMutation(access, key, 'settlement.check', { roundId, ...body }, async (client, userId) => {
    const round = await roundFor(client, roundId, userId)
    version(round, body.expectedVersion)
    state(round, 'LOCKED')
    if (round.finalized_at === null) throw new AppError(409, 'invalid_round_state', '최종 금액이 정해진 뒤 확인할 수 있어요')
    const { rowCount } = await repository.setReceived(client, roundId, userId, senderId ?? null, body.checked as boolean, nowSeconds())
    if (!rowCount) throw new AppError(403, 'forbidden', '확인할 수 있는 수취 내역이 없어요')
    return { id: roundId, roundId, status: round.status, version: round.version }
  })
}

export async function getSettlement(access: Identity, roundId: string): Promise<SettlementDTO> {
  return withReadTransaction(async client => {
    const account = await requireAccount(client, access), round = await roundFor(client, roundId, account.id)
    const checks = await settlementChecksFor(client, roundId), viewerCheck = checks.find(member => member.userId === account.id)
    const checkedCount = checks.filter(member => member.checkedAt !== null).length
    const result: SettlementDTO = { roundId, name: round.name, groupName: round.group_name, status: round.status, version: round.version, isCreator: round.is_creator, finalized: round.finalized_at !== null, currency: round.currency, balanceMinor: null,
      checkedAt: viewerCheck?.checkedAt ?? null, checkRequired: Boolean(viewerCheck), checkedCount, requiredCount: checks.length, allChecked: checkedCount === checks.length,
      confirmations: checks, outgoing: [], incoming: [], sharePath: null }
    if (!result.finalized) return result
    const { rows: balances } = await repository.findBalance(client, roundId, account.id)
    result.balanceMinor = balances[0]?.balance_minor ?? '0'
    result.sharePath = `/settlements/${roundId}`
    const { rows: outgoing } = await repository.findOutgoing(client, roundId, account.id, round.currency)
    const { rows: incoming } = await repository.findIncoming(client, roundId, account.id)
    result.outgoing = outgoing.map(row => ({ receiverId: row.receiver_id, displayName: row.display_name_snapshot, profileImageUrl: row.profile_image_url, amountMinor: row.amount_minor,
      ...(round.currency === 'KRW' ? { account: { bankName: row.bank_name, accountNumber: row.account_number, formattedAccountNumber: row.account_number_formatted, accountHolder: row.account_holder,
        verifiedAt: row.bank_verified_at === null ? null : Number(row.bank_verified_at) } } : {}) }))
    result.incoming = incoming.map(row => ({ senderId: row.sender_id, displayName: row.display_name_snapshot, profileImageUrl: row.profile_image_url, amountMinor: row.amount_minor,
      receivedAt: row.received_at === null ? null : Number(row.received_at) }))
    return result
  })
}

export async function addReceipt(access: Identity, key: string, roundId: string, expenseId: string, expectedVersion: number, bytes: Uint8Array, type: string) {
  const sourceSha256 = createHash('sha256').update(bytes).digest('hex')
  const payload = { roundId, expenseId, expectedVersion, sourceSha256, type }
  const checked = await withReadTransaction(async client => {
    const account = await requireAccount(client, access)
    const replay = await replayMutation<MutationResult>(client, account.id, 'receipt.create', key, payload)
    if (replay.result) return { replayed: replay.result, userId: account.id }
    const round = await roundFor(client, roundId, account.id), expense = await expenseFor(client, roundId, expenseId)
    await editable(client, round, account.id, expense)
    version(round, expectedVersion)
    return { replayed: null, userId: account.id }
  })
  if (checked.replayed) return checked.replayed
  const file = await convertReceipt(bytes, type)
  const objectKey = `receipts/${checked.userId}/${key}.avif`
  // ponytail: a failed DB commit can leave an orphan; add object reconciliation if orphan growth matters.
  await putReceipt(objectKey, file.content, file.mimeType)
  return domainMutation(access, key, 'receipt.create', payload, async (client, userId) => {
    const round = await roundFor(client, roundId, userId), expense = await expenseFor(client, roundId, expenseId)
    await editable(client, round, userId, expense)
    version(round, expectedVersion)
    const id = randomUUID()
    await repository.insertReceipt(client, id, expenseId, userId, file.mimeType, file.content.length, file.sha256, objectKey, nowSeconds())
    return { ...await bump(client, roundId), id }
  })
}

export async function removeReceipt(access: Identity, key: string, roundId: string, expenseId: string, receiptId: string, body: VersionRequestDTO | Record<string, unknown>) {
  onlyKeys(body, ['expectedVersion'])
  let objectKey: string | null = null
  const result = await domainMutation(access, key, 'receipt.delete', { roundId, expenseId, receiptId, ...body }, async (client, userId) => {
    const round = await roundFor(client, roundId, userId), expense = await expenseFor(client, roundId, expenseId)
    await editable(client, round, userId, expense)
    version(round, body.expectedVersion)
    const { rows, rowCount } = await repository.deleteReceipt(client, receiptId, expenseId)
    if (!rowCount) throw missing()
    objectKey = rows[0].object_key
    return { ...await bump(client, roundId), id: receiptId }
  })
  if (objectKey) await cleanupReceiptObjects([objectKey])
  return result
}

export async function getReceipt(access: Identity, receiptId: string) {
  const stored = await withReadTransaction(async client => {
    const account = await requireAccount(client, access)
    const { rows } = await repository.findReceipt(client, receiptId, account.id)
    if (!rows[0]) throw missing()
    const mimeType = rows[0].mime_type as string
    if (rows[0].object_key) return { mimeType, objectKey: rows[0].object_key as string, content: null }
    const { rows: legacy } = await repository.findLegacyReceipt(client, receiptId)
    return { mimeType, objectKey: null, content: legacy[0].content as Uint8Array }
  })
  return { mimeType: stored.mimeType, content: stored.content ?? await readReceipt(stored.objectKey!) }
}
