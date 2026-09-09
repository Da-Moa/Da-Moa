import { createHash, randomInt, randomUUID } from 'node:crypto'
import { requireAccount } from './authorization'
import { withReadTransaction, type Database } from './db'
import { AppError, badInput } from './errors'
import { domainMutation, idsInput, missing, nowSeconds, onlyKeys, ownerGroup, pageOf, pagination, textInput, type Identity } from './group-store'
import { formatMoney, MAX_EXPENSE_MAJOR, MAX_ROUND_TOTAL_MAJOR, minorLimit, parseAmount, requireCurrency, type Currency } from './money'
import { calculateBase, finalizeSettlement, previewSettlement } from './split'
import type { ExclusionCheck, Expense, MutationResult, RoundDetail, RoundMember, RoundStatus, RoundSummary, SettlementDTO, SettlementTransfer } from './domain-types'

type Row = Record<string, any>

async function roundFor(client: Database, id: string, userId: string): Promise<Row> {
  const { rows } = await client.query(`SELECT r.*,g.name AS group_name,g.creator_id AS group_creator_id,
    (r.creator_id=$2) AS is_creator
    FROM rounds r JOIN groups g ON g.id=r.group_id JOIN round_members m ON m.round_id=r.id AND m.user_id=$2 WHERE r.id=$1`, [id, userId])
  if (!rows[0]) throw missing()
  return rows[0]
}

function creator(round: Row) {
  if (!round.is_creator) throw new AppError(403, 'forbidden', '회차 생성자만 할 수 있어요')
}

function state(round: Row, expected: RoundStatus) {
  if (round.status !== expected || (expected !== 'COMPLETED' && round.completed_at !== null)) {
    throw new AppError(409, 'invalid_round_state', '현재 회차 상태에서는 할 수 없어요. 최신 상태를 확인해 주세요')
  }
}

function version(round: Row, value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) badInput('invalid_version', '회차 버전이 필요합니다')
  if (round.version !== value) throw new AppError(409, 'stale_round', '다른 변경이 먼저 저장됐어요. 최신 내역을 확인해 주세요', { version: round.version })
}

async function bump(client: Database, id: string): Promise<MutationResult> {
  const { rows } = await client.query('UPDATE rounds SET version=version+1 WHERE id=$1 RETURNING id,status,version', [id])
  return { ...rows[0], roundId: id }
}

async function membersFor(client: Database, roundId: string): Promise<RoundMember[]> {
  const { rows } = await client.query(`SELECT rm.user_id,rm.display_name_snapshot,rm.excluded_at,
    CASE WHEN u.deleted_at IS NULL THEN u.profile_image_url ELSE NULL END AS profile_image_url
    FROM round_members rm JOIN users u ON u.id=rm.user_id WHERE rm.round_id=$1 ORDER BY rm.user_id`, [roundId])
  return rows.map(row => ({ userId: row.user_id, displayName: row.display_name_snapshot, profileImageUrl: row.profile_image_url, excludedAt: row.excluded_at === null ? null : Number(row.excluded_at) }))
}

async function expensesFor(client: Database, roundId: string, query?: URLSearchParams) {
  const { limit, cursor } = query ? pagination(query) : { limit: null, cursor: null }
  const { rows } = await client.query(`SELECT * FROM expenses WHERE round_id=$1 AND ($2::bigint IS NULL OR (created_at,id)<($2::bigint,$3::text)) ORDER BY created_at DESC,id DESC LIMIT $4`, [roundId, cursor?.createdAt ?? null, cursor?.id ?? null, limit === null ? null : limit + 1])
  const ids = rows.map(row => row.id)
  const { rows: shares } = await client.query('SELECT * FROM expense_shares WHERE expense_id=ANY($1::text[]) ORDER BY user_id', [ids])
  const { rows: receipts } = await client.query('SELECT id,expense_id,mime_type,byte_size FROM expense_receipts WHERE expense_id=ANY($1::text[]) ORDER BY created_at,id', [ids])
  const items: Expense[] = rows.map(row => {
    const part = shares.filter(share => share.expense_id === row.id)
    const base = calculateBase(BigInt(row.amount_minor), part.length)
    return {
      id: row.id, authorId: row.author_id, payerId: row.payer_id, description: row.description, amountMinor: row.amount_minor,
      splitMode: row.split_mode, participantIds: part.map(s => s.user_id), baseShareMinor: row.base_share_minor ?? base.base.toString(), remainderUnits: row.remainder_units ?? base.remainder,
      shares: part.map(s => ({ userId: s.user_id, amountMinor: s.final_amount_minor, receivedRemainder: s.received_remainder })),
      receipts: receipts.filter(r => r.expense_id === row.id).map(r => ({ id: r.id, mimeType: r.mime_type, byteSize: r.byte_size })),
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    }
  })
  return limit === null ? { items, nextCursor: null } : pageOf(items, limit, row => row)
}

async function settlementExpensesFor(client: Database, roundId: string): Promise<Pick<Expense, 'id' | 'payerId' | 'amountMinor' | 'splitMode' | 'participantIds'>[]> {
  const { rows } = await client.query(`SELECT e.id,e.payer_id,e.amount_minor,e.split_mode,
    ARRAY(SELECT s.user_id FROM expense_shares s WHERE s.expense_id=e.id ORDER BY s.user_id) AS participant_ids
    FROM expenses e WHERE e.round_id=$1 ORDER BY e.id`, [roundId])
  return rows.map(row => ({ id: row.id, payerId: row.payer_id, amountMinor: row.amount_minor, splitMode: row.split_mode, participantIds: row.participant_ids }))
}

async function settlementChecksFor(client: Database, roundId: string) {
  const { rows } = await client.query(`SELECT rm.user_id,rm.display_name_snapshot,
    CASE WHEN bool_and(t.received_at IS NOT NULL) THEN max(t.received_at) ELSE NULL END AS checked_at,
    CASE WHEN u.deleted_at IS NULL THEN u.profile_image_url ELSE NULL END AS profile_image_url
    FROM settlement_transfers t JOIN round_members rm ON rm.round_id=t.round_id AND rm.user_id=t.receiver_id
    JOIN users u ON u.id=rm.user_id WHERE t.round_id=$1
    GROUP BY rm.user_id,rm.display_name_snapshot,u.deleted_at,u.profile_image_url ORDER BY rm.user_id`, [roundId])
  return rows.map(row => ({ userId: String(row.user_id), displayName: String(row.display_name_snapshot), profileImageUrl: row.profile_image_url as string | null,
    checkedAt: row.checked_at === null ? null : Number(row.checked_at) }))
}

function summary(row: Row): RoundSummary {
  return {
    id: row.id, groupId: row.group_id, groupName: row.group_name, name: row.name, currency: row.currency,
    status: row.status, version: row.version, createdAt: Number(row.created_at),
    finalizedAt: row.finalized_at === null ? null : Number(row.finalized_at), completedAt: row.completed_at === null ? null : Number(row.completed_at),
    balanceMinor: row.balance_minor ?? null, totalMinor: row.total_minor ?? '0', memberCount: Number(row.member_count ?? 0),
  }
}

export async function listRounds(access: Identity, query: URLSearchParams, groupId?: string) {
  const { limit, cursor } = pagination(query)
  const status = query.get('status')
  const search = query.has('q') ? textInput(query.get('q'), 100) : null
  if (status && !['active', 'RECORDING', 'CONFIRMED', 'LOCKED', 'COMPLETED'].includes(status)) badInput()
  return withReadTransaction(async client => {
    const account = await requireAccount(client, access)
    const { rows } = await client.query(`SELECT r.*,g.name AS group_name,b.balance_minor,
      (SELECT COALESCE(sum(amount_minor),0)::text FROM expenses WHERE round_id=r.id) AS total_minor,
      (SELECT count(*) FROM round_members WHERE round_id=r.id AND excluded_at IS NULL) AS member_count
      FROM rounds r JOIN groups g ON g.id=r.group_id JOIN round_members m ON m.round_id=r.id AND m.user_id=$1
      LEFT JOIN settlement_balances b ON b.round_id=r.id AND b.user_id=$1
      WHERE ($2::text IS NULL OR r.group_id=$2) AND ($3::text IS NULL OR ($3='active' AND r.status<>'COMPLETED') OR r.status=$3)
      AND ($4::text IS NULL OR strpos(lower(r.name),lower($4))>0 OR strpos(lower(g.name),lower($4))>0)
      AND ($5::bigint IS NULL OR (r.created_at,r.id)<($5::bigint,$6::text)) ORDER BY r.created_at DESC,r.id DESC LIMIT $7`, [account.id, groupId ?? null, status, search, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1])
    return pageOf(rows.map(summary), limit, row => row)
  })
}

export async function getRound(access: Identity, roundId: string, query: URLSearchParams): Promise<RoundDetail> {
  return withReadTransaction(async client => {
    const account = await requireAccount(client, access)
    const round = await roundFor(client, roundId, account.id)
    const members = await membersFor(client, roundId)
    const expenses = await expensesFor(client, roundId, query)
    const { rows: totals } = await client.query('SELECT COALESCE(sum(amount_minor),0)::text AS total_minor FROM expenses WHERE round_id=$1', [roundId])
    const { rows: balances } = await client.query('SELECT balance_minor FROM settlement_balances WHERE round_id=$1 AND user_id=$2', [roundId, account.id])
    let transfers: SettlementTransfer[] = [], pendingRemainderMinor = '0'
    if (round.finalized_at === null) {
      const allExpenses = !query.has('cursor') && expenses.nextCursor === null ? expenses.items : await settlementExpensesFor(client, roundId)
      if (allExpenses.length) ({ transfers, pendingRemainderMinor } = previewSettlement(allExpenses, members.map(member => member.userId)))
    } else {
      const { rows } = await client.query('SELECT sender_id,receiver_id,amount_minor FROM settlement_transfers WHERE round_id=$1 AND (sender_id=$2 OR receiver_id=$2) ORDER BY sender_id,receiver_id', [roundId, account.id])
      transfers = rows.map(row => ({ senderId: row.sender_id, receiverId: row.receiver_id, amountMinor: row.amount_minor }))
    }
    transfers = transfers.filter(transfer => transfer.senderId === account.id || transfer.receiverId === account.id)
    return {
      ...summary({ ...round, ...totals[0], ...balances[0], member_count: members.filter(m => m.excludedAt === null).length }),
      creatorId: round.creator_id, groupCreatorId: round.group_creator_id, isCreator: round.is_creator, members, expenses: expenses.items, expensesNextCursor: expenses.nextCursor,
      transfers, pendingRemainderMinor,
    }
  })
}

export async function createRound(access: Identity, key: string, groupId: string, body: Record<string, unknown>) {
  onlyKeys(body, ['name', 'currency', 'participantIds'])
  const name = textInput(body.name, 100), ids = idsInput(body.participantIds)
  let currency: Currency
  try { currency = requireCurrency(body.currency) } catch { badInput('unsupported_currency', 'USD, KRW, JPY 중 선택해 주세요') }
  return domainMutation(access, key, 'round.create', { groupId, ...body }, async (client, userId) => {
    await ownerGroup(client, groupId, userId, false)
    if (ids.length < 2 || !ids.includes(userId)) throw new AppError(409, 'minimum_participants', '회차 생성자를 포함해 최소 2명을 선택해 주세요')
    const { rows } = await client.query(`SELECT u.id,COALESCE(u.display_name,'카카오 사용자') AS name FROM group_members m JOIN users u ON u.id=m.user_id
      WHERE m.group_id=$1 AND m.user_id=ANY($2::text[]) AND m.left_at IS NULL AND u.deleted_at IS NULL AND u.onboarding_completed_at IS NOT NULL ORDER BY u.id`, [groupId, ids])
    if (rows.length !== ids.length) badInput('invalid_participants', '현재 모임 참여자만 선택할 수 있어요')
    const id = randomUUID(), now = nowSeconds()
    await client.query('INSERT INTO rounds(id,group_id,creator_id,name,currency,status,version,created_at) VALUES($1,$2,$3,$4,$5,\'RECORDING\',1,$6)', [id, groupId, userId, name, currency, now])
    for (const member of rows) await client.query('INSERT INTO round_members(round_id,user_id,display_name_snapshot,joined_at) VALUES($1,$2,$3,$4)', [id, member.id, member.name, now])
    return { id, roundId: id, status: 'RECORDING', version: 1 }
  })
}

async function expenseFor(client: Database, roundId: string, expenseId: string): Promise<Row> {
  const { rows } = await client.query('SELECT * FROM expenses WHERE id=$1 AND round_id=$2', [expenseId, roundId])
  if (!rows[0]) throw missing()
  return rows[0]
}

async function editable(client: Database, round: Row, userId: string, expense?: Row) {
  state(round, 'RECORDING')
  if (round.is_creator) return
  const { rows } = await client.query('SELECT 1 FROM round_members WHERE round_id=$1 AND user_id=$2 AND excluded_at IS NULL', [round.id, userId])
  if (!rows.length || (expense && expense.author_id !== userId)) throw new AppError(403, 'forbidden', '지출 작성자 또는 회차 생성자만 수정할 수 있어요')
}

async function expenseInput(client: Database, round: Row, body: Record<string, unknown>, previous?: Row) {
  onlyKeys(body, ['description', 'amount', 'payerId', 'splitMode', 'participantIds', 'expectedVersion'])
  const description = textInput(body.description === undefined ? previous?.description : body.description, 500)
  const currency = round.currency as Currency
  let amount: bigint
  try { amount = body.amount === undefined && previous ? BigInt(previous.amount_minor) : parseAmount(body.amount, currency) } catch { badInput('invalid_amount', '통화에 맞는 양의 금액을 정확히 입력해 주세요') }
  const maximum = minorLimit(MAX_EXPENSE_MAJOR, currency)
  if (amount > maximum) badInput('expense_amount_limit_exceeded', `지출 금액은 ${formatMoney(maximum.toString(), currency)} 이하여야 해요`)
  const payerId = textInput(body.payerId === undefined ? previous?.payer_id : body.payerId, 128)
  const splitMode = body.splitMode === undefined ? previous?.split_mode : body.splitMode
  if (splitMode !== 'ALL' && splitMode !== 'SELECTED') badInput('invalid_participants', '분배 방식을 선택해 주세요')
  const members = await membersFor(client, round.id), active = members.filter(m => m.excludedAt === null).map(m => m.userId)
  if (!active.includes(payerId) && payerId !== previous?.payer_id) badInput('invalid_participants', '결제자는 이번 회차 참여자여야 합니다')
  let participantIds: string[]
  if (splitMode === 'ALL') {
    if (body.participantIds !== undefined) badInput('invalid_participants', '전체 분배의 참여자는 서버에서 결정합니다')
    participantIds = active
  } else {
    const previousShares = previous && body.participantIds === undefined ? await client.query('SELECT user_id FROM expense_shares WHERE expense_id=$1 ORDER BY user_id', [previous.id]) : null
    participantIds = idsInput(body.participantIds === undefined ? previousShares?.rows.map(s => s.user_id) : body.participantIds)
    if (participantIds.some(id => !active.includes(id))) badInput('invalid_participants', '부담자는 제외되지 않은 회차 참여자여야 합니다')
  }
  if (!participantIds.length) badInput('invalid_participants', '부담자가 필요합니다')
  return { description, amount: amount.toString(), payerId, splitMode, participantIds }
}

async function storeShares(client: Database, expenseId: string, roundId: string, ids: string[]) {
  await client.query('DELETE FROM expense_shares WHERE expense_id=$1', [expenseId])
  await client.query('INSERT INTO expense_shares(expense_id,round_id,user_id) SELECT $1,$2,unnest($3::text[])', [expenseId, roundId, ids])
}

export async function saveExpense(access: Identity, key: string, roundId: string, body: Record<string, unknown>, expenseId?: string) {
  return domainMutation(access, key, expenseId ? 'expense.update' : 'expense.create', { roundId, expenseId, ...body }, async (client, userId) => {
    const round = await roundFor(client, roundId, userId)
    const previous = expenseId ? await expenseFor(client, roundId, expenseId) : undefined
    await editable(client, round, userId, previous)
    version(round, body.expectedVersion)
    const input = await expenseInput(client, round, body, previous), now = nowSeconds(), id = expenseId ?? randomUUID()
    const { rows: totals } = await client.query('SELECT COALESCE(sum(amount_minor),0)::text AS total_minor FROM expenses WHERE round_id=$1', [roundId])
    const nextTotal = BigInt(totals[0].total_minor) - BigInt(previous?.amount_minor ?? 0) + BigInt(input.amount)
    const maximum = minorLimit(MAX_ROUND_TOTAL_MAJOR, round.currency as Currency)
    if (nextTotal > maximum) badInput('round_total_limit_exceeded', `회차 전체 지출은 ${formatMoney(maximum.toString(), round.currency as Currency)} 이하여야 해요`)
    if (previous) {
      await client.query('UPDATE expenses SET description=$2,amount_minor=$3,payer_id=$4,split_mode=$5,base_share_minor=NULL,remainder_units=NULL,updated_at=$6,updated_by=$7 WHERE id=$1', [id, input.description, input.amount, input.payerId, input.splitMode, now, userId])
    } else {
      await client.query('INSERT INTO expenses(id,round_id,author_id,payer_id,description,amount_minor,split_mode,created_at,updated_at,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$3)', [id, roundId, userId, input.payerId, input.description, input.amount, input.splitMode, now])
    }
    await storeShares(client, id, roundId, input.participantIds)
    return { ...await bump(client, roundId), id }
  })
}

export async function deleteExpense(access: Identity, key: string, roundId: string, expenseId: string, body: Record<string, unknown>) {
  onlyKeys(body, ['expectedVersion'])
  return domainMutation(access, key, 'expense.delete', { roundId, expenseId, ...body }, async (client, userId) => {
    const round = await roundFor(client, roundId, userId), expense = await expenseFor(client, roundId, expenseId)
    await editable(client, round, userId, expense)
    version(round, body.expectedVersion)
    await client.query('DELETE FROM expenses WHERE id=$1', [expenseId])
    return { ...await bump(client, roundId), id: expenseId }
  })
}

async function exclusions(client: Database, round: Row, targetId: string): Promise<ExclusionCheck> {
  const members = await membersFor(client, round.id)
  const member = members.find(m => m.userId === targetId)
  if (!member) throw missing()
  const { rows } = await client.query(`SELECT e.id,e.description,e.amount_minor,e.author_id,a.display_name_snapshot AS author_name,
    CASE WHEN e.payer_id=$2 THEN 'payer_and_participant' ELSE 'selected_participant' END AS reason
    FROM expenses e JOIN expense_shares s ON s.expense_id=e.id AND s.user_id=$2
    JOIN round_members a ON a.round_id=e.round_id AND a.user_id=e.author_id
    WHERE e.round_id=$1 AND (e.payer_id=$2 OR e.split_mode='SELECTED') ORDER BY e.created_at,e.id`, [round.id, targetId])
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

export async function excludeMember(access: Identity, key: string, roundId: string, targetId: string, body: Record<string, unknown>) {
  onlyKeys(body, ['expectedVersion'])
  return domainMutation(access, key, 'member.exclude', { roundId, targetId, ...body }, async (client, userId) => {
    const round = await roundFor(client, roundId, userId)
    creator(round)
    state(round, 'RECORDING')
    version(round, body.expectedVersion)
    const check = await exclusions(client, round, targetId)
    if (!check.allowed) throw new AppError(409, check.reason === 'minimum_participants' ? check.reason : 'member_exclusion_blocked', check.expenses.length ? '해당 사용자와 연관된 정산이 있습니다.' : check.reason === 'minimum_participants' ? '회차는 최소 2명이어야 합니다' : '해당 사용자는 제외할 수 없어요', check)
    await client.query('UPDATE round_members SET excluded_at=$3 WHERE round_id=$1 AND user_id=$2', [roundId, targetId, nowSeconds()])
    await client.query("DELETE FROM expense_shares s USING expenses e WHERE s.expense_id=e.id AND e.round_id=$1 AND e.split_mode='ALL' AND s.user_id=$2", [roundId, targetId])
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
    if (amount > minorLimit(MAX_EXPENSE_MAJOR, currency)) badInput('expense_amount_limit_exceeded', `지출 금액은 ${formatMoney(minorLimit(MAX_EXPENSE_MAJOR, currency).toString(), currency)} 이하여야 해요`)
    total += amount
  }
  if (total > minorLimit(MAX_ROUND_TOTAL_MAJOR, currency)) badInput('round_total_limit_exceeded', `회차 전체 지출은 ${formatMoney(minorLimit(MAX_ROUND_TOTAL_MAJOR, currency).toString(), currency)} 이하여야 해요`)
  return { items, members }
}

async function finalize(client: Database, roundId: string, currency: Currency, draw: boolean) {
  const { items, members } = await validatedExpenses(client, roundId, currency)
  const result = finalizeSettlement(items, members.map(m => m.userId), draw ? max => randomInt(max) : undefined)
  for (const share of result.shares) await client.query('UPDATE expense_shares SET final_amount_minor=$3,received_remainder=$4 WHERE expense_id=$1 AND user_id=$2', [share.expenseId, share.userId, share.amountMinor, share.receivedRemainder])
  for (const balance of result.balances) await client.query('INSERT INTO settlement_balances(round_id,user_id,paid_minor,burden_minor,balance_minor) VALUES($1,$2,$3,$4,$5)', [roundId, balance.userId, balance.paidMinor, balance.burdenMinor, balance.balanceMinor])
  for (const transfer of result.transfers) await client.query('INSERT INTO settlement_transfers(round_id,sender_id,receiver_id,amount_minor) VALUES($1,$2,$3,$4)', [roundId, transfer.senderId, transfer.receiverId, transfer.amountMinor])
  await client.query('UPDATE rounds SET finalized_at=$2 WHERE id=$1', [roundId, nowSeconds()])
}

export async function roundCommand(access: Identity, key: string, roundId: string, action: string, body: Record<string, unknown>) {
  onlyKeys(body, ['expectedVersion'])
  if (!['confirm', 'reopen', 'send', 'draw', 'complete', 'force-complete', 'cancel'].includes(action)) throw missing()
  return domainMutation(access, key, `round.${action}`, { roundId, ...body }, async (client, userId) => {
    const round = await roundFor(client, roundId, userId)
    creator(round)
    if (action === 'draw' && round.finalized_at !== null) return { id: roundId, roundId, status: round.status, version: round.version }
    version(round, body.expectedVersion)
    const now = nowSeconds()
    if (action === 'confirm') {
      state(round, 'RECORDING')
      const { items } = await validatedExpenses(client, roundId, round.currency as Currency)
      for (const expense of items) {
        const base = calculateBase(BigInt(expense.amountMinor), expense.participantIds.length)
        await client.query('UPDATE expenses SET base_share_minor=$2,remainder_units=$3 WHERE id=$1', [expense.id, base.base.toString(), base.remainder])
      }
      await client.query("UPDATE rounds SET status='CONFIRMED',confirmed_at=$2 WHERE id=$1", [roundId, now])
    } else if (action === 'reopen') {
      state(round, 'CONFIRMED')
      await client.query('UPDATE expenses SET base_share_minor=NULL,remainder_units=NULL WHERE round_id=$1', [roundId])
      await client.query("UPDATE rounds SET status='RECORDING',confirmed_at=NULL WHERE id=$1", [roundId])
    } else if (action === 'send') {
      state(round, 'CONFIRMED')
      await validatedExpenses(client, roundId, round.currency as Currency)
      await client.query("UPDATE rounds SET status='LOCKED',locked_at=$2 WHERE id=$1", [roundId, now])
      const { rows } = await client.query('SELECT 1 FROM expenses WHERE round_id=$1 AND remainder_units>0 LIMIT 1', [roundId])
      if (!rows.length) await finalize(client, roundId, round.currency as Currency, false)
    } else if (action === 'draw') {
      state(round, 'LOCKED')
      await finalize(client, roundId, round.currency as Currency, true)
    } else if (action === 'complete' || action === 'force-complete') {
      state(round, 'LOCKED')
      if (round.finalized_at === null) throw new AppError(409, 'invalid_round_state', '나머지 배분을 먼저 완료해 주세요')
      if (action === 'complete') {
        const { rows } = await client.query('SELECT count(*)::int AS count FROM settlement_transfers WHERE round_id=$1 AND received_at IS NULL', [roundId])
        if (rows[0].count) throw new AppError(409, 'pending_settlement_checks', '모든 수취인이 입금을 확인한 뒤 종료할 수 있어요', { pendingCount: rows[0].count })
      }
      await client.query("UPDATE rounds SET status='COMPLETED',completed_at=$2 WHERE id=$1", [roundId, now])
    } else {
      state(round, 'RECORDING')
      await client.query('DELETE FROM rounds WHERE id=$1', [roundId])
      return { id: roundId, roundId }
    }
    return bump(client, roundId)
  })
}

export async function setSettlementCheck(access: Identity, key: string, roundId: string, body: Record<string, unknown>) {
  onlyKeys(body, ['expectedVersion', 'checked', 'senderId'])
  if (typeof body.checked !== 'boolean') badInput('invalid_input', '정산 확인 여부를 선택해 주세요')
  if (body.senderId !== undefined && (typeof body.senderId !== 'string' || body.senderId !== body.senderId.trim() || !/^[\w-]{1,128}$/.test(body.senderId))) badInput('invalid_input', '확인할 송금자를 다시 선택해 주세요')
  const senderId = body.senderId as string | undefined
  return domainMutation(access, key, 'settlement.check', { roundId, ...body }, async (client, userId) => {
    const round = await roundFor(client, roundId, userId)
    version(round, body.expectedVersion)
    state(round, 'LOCKED')
    if (round.finalized_at === null) throw new AppError(409, 'invalid_round_state', '최종 금액이 정해진 뒤 확인할 수 있어요')
    const { rowCount } = await client.query(`UPDATE settlement_transfers SET received_at=CASE
      WHEN $4 THEN COALESCE(received_at,$5) ELSE NULL END
      WHERE round_id=$1 AND receiver_id=$2 AND ($3::text IS NULL OR sender_id=$3)`, [roundId, userId, senderId ?? null, body.checked, nowSeconds()])
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
    const { rows: balances } = await client.query('SELECT balance_minor FROM settlement_balances WHERE round_id=$1 AND user_id=$2', [roundId, account.id])
    result.balanceMinor = balances[0]?.balance_minor ?? '0'
    result.sharePath = `/settlements/${roundId}`
    // Only the viewer's actual recipients are joined to bank fields; ownership gives no extra bank visibility.
    const bankFields = round.currency === 'KRW' ? ',u.bank_name,u.account_number,u.account_holder' : ''
    const { rows: outgoing } = await client.query(`SELECT t.receiver_id,t.amount_minor,m.display_name_snapshot,
      CASE WHEN u.deleted_at IS NULL THEN u.profile_image_url ELSE NULL END AS profile_image_url${bankFields} FROM settlement_transfers t
      JOIN round_members m ON m.round_id=t.round_id AND m.user_id=t.receiver_id JOIN users u ON u.id=t.receiver_id
      WHERE t.round_id=$1 AND t.sender_id=$2 AND t.received_at IS NULL ORDER BY t.receiver_id`, [roundId, account.id])
    const { rows: incoming } = await client.query(`SELECT t.sender_id,t.amount_minor,t.received_at,m.display_name_snapshot,
      CASE WHEN u.deleted_at IS NULL THEN u.profile_image_url ELSE NULL END AS profile_image_url FROM settlement_transfers t
      JOIN round_members m ON m.round_id=t.round_id AND m.user_id=t.sender_id JOIN users u ON u.id=t.sender_id
      WHERE t.round_id=$1 AND t.receiver_id=$2 ORDER BY t.sender_id`, [roundId, account.id])
    result.outgoing = outgoing.map(row => ({ receiverId: row.receiver_id, displayName: row.display_name_snapshot, profileImageUrl: row.profile_image_url, amountMinor: row.amount_minor,
      ...(round.currency === 'KRW' ? { account: { bankName: row.bank_name, accountNumber: row.account_number, accountHolder: row.account_holder } } : {}) }))
    result.incoming = incoming.map(row => ({ senderId: row.sender_id, displayName: row.display_name_snapshot, profileImageUrl: row.profile_image_url, amountMinor: row.amount_minor,
      receivedAt: row.received_at === null ? null : Number(row.received_at) }))
    return result
  })
}

async function convertReceipt(content: Uint8Array, claimedType: string) {
  const source = Buffer.from(content)
  try {
    const { default: sharp } = await import('sharp')
    const image = sharp(source, { failOn: 'error' })
    const format = (await image.metadata()).format
    const mimeType = format === 'jpeg' ? 'image/jpeg' : format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : null
    if (!mimeType || (claimedType && claimedType !== mimeType)) throw new AppError(415, 'unsupported_receipt_type', 'JPEG, PNG, WebP 이미지 파일을 선택해 주세요')
    const converted = await image.autoOrient().avif({ quality: 80, effort: 2 }).toBuffer()
    return { content: converted, mimeType: 'image/avif', sha256: createHash('sha256').update(converted).digest('hex') }
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError(415, 'unsupported_receipt_type', 'JPEG, PNG, WebP 이미지 파일을 선택해 주세요')
  }
}

export async function addReceipt(access: Identity, key: string, roundId: string, expenseId: string, expectedVersion: number, bytes: Uint8Array, type: string) {
  const sourceSha256 = createHash('sha256').update(bytes).digest('hex')
  const file = await convertReceipt(bytes, type)
  return domainMutation(access, key, 'receipt.create', { roundId, expenseId, expectedVersion, sourceSha256, type }, async (client, userId) => {
    const round = await roundFor(client, roundId, userId), expense = await expenseFor(client, roundId, expenseId)
    await editable(client, round, userId, expense)
    version(round, expectedVersion)
    const id = randomUUID()
    await client.query('INSERT INTO expense_receipts(id,expense_id,uploaded_by,mime_type,byte_size,sha256,content,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [id, expenseId, userId, file.mimeType, file.content.length, file.sha256, file.content, nowSeconds()])
    return { ...await bump(client, roundId), id }
  })
}

export async function removeReceipt(access: Identity, key: string, roundId: string, expenseId: string, receiptId: string, body: Record<string, unknown>) {
  onlyKeys(body, ['expectedVersion'])
  return domainMutation(access, key, 'receipt.delete', { roundId, expenseId, receiptId, ...body }, async (client, userId) => {
    const round = await roundFor(client, roundId, userId), expense = await expenseFor(client, roundId, expenseId)
    await editable(client, round, userId, expense)
    version(round, body.expectedVersion)
    const { rowCount } = await client.query('DELETE FROM expense_receipts WHERE id=$1 AND expense_id=$2', [receiptId, expenseId])
    if (!rowCount) throw missing()
    return { ...await bump(client, roundId), id: receiptId }
  })
}

export async function getReceipt(access: Identity, receiptId: string) {
  return withReadTransaction(async client => {
    const account = await requireAccount(client, access)
    const { rows } = await client.query(`SELECT r.mime_type,r.content FROM expense_receipts r JOIN expenses e ON e.id=r.expense_id
      JOIN round_members m ON m.round_id=e.round_id AND m.user_id=$2 WHERE r.id=$1`, [receiptId, account.id])
    if (!rows[0]) throw missing()
    return { mimeType: rows[0].mime_type as string, content: new Uint8Array(rows[0].content) }
  })
}
