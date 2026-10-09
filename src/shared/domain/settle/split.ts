import { MAX_ROUND_CURRENCIES, requireCurrency, type Currency } from './money'

export function calculateBase(total: bigint, count: number): { base: bigint; remainder: number } {
  if (typeof total !== 'bigint' || total <= 0n) throw new Error('invalid_amount')
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error('invalid_participants')
  return { base: total / BigInt(count), remainder: Number(total % BigInt(count)) }
}

type SettlementExpense = {
  id: string; payerId: string; amountMinor: string; participantIds: string[];
  splitMode?: 'ALL' | 'SELECTED' | 'CUSTOM';
  shares?: { userId: string; assignedAmountMinor: string | null }[]
}
type FinalShare = { expenseId: string; userId: string; amountMinor: string; receivedRemainder: boolean }
type FinalBalance = { userId: string; paidMinor: string; burdenMinor: string; balanceMinor: string }
type FinalTransfer = { senderId: string; receiverId: string; amountMinor: string }
type SettlementResult = { shares: FinalShare[]; balances: FinalBalance[]; transfers: FinalTransfer[] }

function settlementAmount(value: unknown, allowZero = false) {
  if (typeof value !== 'string' || value !== value.trim() || !/^\d+$/.test(value)) throw new Error('invalid_amount')
  const amount = BigInt(value)
  if (amount < 0n || (!allowZero && amount === 0n)) throw new Error('invalid_amount')
  return amount
}

export function validateCustomShares(total: bigint, participantIds: string[], shares: SettlementExpense['shares']): Map<string, bigint> {
  if (typeof total !== 'bigint' || total <= 0n) throw new Error('invalid_amount')
  if (!Array.isArray(participantIds) || !participantIds.length || participantIds.some(id => typeof id !== 'string' || !id) ||
      new Set(participantIds).size !== participantIds.length || !Array.isArray(shares) || shares.length !== participantIds.length) {
    throw new Error('invalid_participants')
  }
  const assigned = new Map<string, bigint>()
  let sum = 0n
  for (const share of shares) {
    if (!share || !participantIds.includes(share.userId) || assigned.has(share.userId)) throw new Error('invalid_participants')
    const amount = settlementAmount(share.assignedAmountMinor)
    assigned.set(share.userId, amount)
    sum += amount
  }
  if (sum !== total) throw new Error('custom_share_total_mismatch')
  return assigned
}

/**
 * Pure calculation. The server supplies crypto.randomInt for a locked round;
 * the caller commits this entire result atomically and never redraws a saved result.
 */
function settle(
  expenses: SettlementExpense[],
  memberIds: string[],
  draw?: (max: number) => number,
  allowZero = false,
): SettlementResult {
  const members = [...memberIds].sort()
  if (!members.length || new Set(members).size !== members.length || members.some(id => typeof id !== 'string' || !id)) {
    throw new Error('invalid_participants')
  }
  if (!expenses.length) throw new Error('empty_expenses')
  const totals = new Map(members.map(id => [id, { paid: 0n, burden: 0n }]))
  const shares: FinalShare[] = []
  const expenseIds = new Set<string>()

  for (const expense of [...expenses].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    if (typeof expense.id !== 'string' || !expense.id || expenseIds.has(expense.id)) throw new Error('invalid_expenses')
    expenseIds.add(expense.id)
    const payer = totals.get(expense.payerId)
    const participants = [...expense.participantIds].sort()
    if (!payer || !participants.length || new Set(participants).size !== participants.length || participants.some(id => !totals.has(id))) {
      throw new Error('invalid_participants')
    }
    const total = settlementAmount(expense.amountMinor, allowZero)
    const assigned = expense.splitMode === 'CUSTOM' ? validateCustomShares(total, participants, expense.shares) : undefined
    const { base, remainder } = assigned || total === 0n ? { base: 0n, remainder: 0 } : calculateBase(total, participants.length)
    if (remainder && !draw) throw new Error('remainder_draw_required')
    const candidates = [...participants]
    const winners = new Set<string>()
    for (let index = 0; index < remainder; index++) {
      const available = candidates.length - index
      const offset = draw!(available)
      if (!Number.isInteger(offset) || offset < 0 || offset >= available) throw new Error('invalid_draw')
      const selected = index + offset
      ;[candidates[index], candidates[selected]] = [candidates[selected], candidates[index]]
      winners.add(candidates[index])
    }
    payer.paid += total
    for (const userId of participants) {
      const receivedRemainder = winners.has(userId)
      const amount = assigned?.get(userId) ?? base + (receivedRemainder ? 1n : 0n)
      totals.get(userId)!.burden += amount
      shares.push({ expenseId: expense.id, userId, amountMinor: amount.toString(), receivedRemainder })
    }
  }

  const balances = members.map(userId => {
    const { paid, burden } = totals.get(userId)!
    return { userId, paidMinor: paid.toString(), burdenMinor: burden.toString(), balanceMinor: (burden - paid).toString() }
  })
  const senders = balances.filter(row => BigInt(row.balanceMinor) > 0n).map(row => ({ userId: row.userId, remaining: BigInt(row.balanceMinor) }))
  const receivers = balances.filter(row => BigInt(row.balanceMinor) < 0n).map(row => ({ userId: row.userId, remaining: -BigInt(row.balanceMinor) }))
  const transfers: FinalTransfer[] = []
  let receiverIndex = 0
  for (const sender of senders) {
    while (sender.remaining > 0n) {
      const receiver = receivers[receiverIndex]
      if (!receiver) throw new Error('unbalanced_settlement')
      const amount = sender.remaining < receiver.remaining ? sender.remaining : receiver.remaining
      transfers.push({ senderId: sender.userId, receiverId: receiver.userId, amountMinor: amount.toString() })
      sender.remaining -= amount
      receiver.remaining -= amount
      if (receiver.remaining === 0n) receiverIndex++
    }
  }
  if (receiverIndex !== receivers.length) throw new Error('unbalanced_settlement')
  return { shares, balances, transfers }
}

export function finalizeSettlement(expenses: SettlementExpense[], memberIds: string[], draw?: (max: number) => number): SettlementResult {
  return settle(expenses, memberIds, draw)
}

export function previewSettlement(expenses: SettlementExpense[], memberIds: string[]): SettlementResult & { pendingRemainderMinor: string } {
  let pending = 0n
  const allocated = expenses.map(expense => {
    if (expense.splitMode === 'CUSTOM') return expense
    const total = settlementAmount(expense.amountMinor)
    const { base, remainder } = calculateBase(total, expense.participantIds.length)
    pending += BigInt(remainder)
    return { ...expense, amountMinor: (base * BigInt(expense.participantIds.length)).toString() }
  })
  return { ...settle(allocated, memberIds, undefined, true), pendingRemainderMinor: pending.toString() }
}


type CurrencyExpense = SettlementExpense & { currency: Currency }

function currencyGroups(expenses: CurrencyExpense[]) {
  if (!expenses.length) throw new Error('empty_expenses')
  if (new Set(expenses.map(expense => expense.id)).size !== expenses.length) throw new Error('invalid_expenses')
  const groups = new Map<Currency, CurrencyExpense[]>()
  for (const expense of expenses) {
    const currency = requireCurrency(expense.currency)
    const items = groups.get(currency) ?? []
    items.push(expense)
    groups.set(currency, items)
  }
  if (groups.size > MAX_ROUND_CURRENCIES) throw new Error('round_currency_limit_exceeded')
  return [...groups].sort(([a], [b]) => a.localeCompare(b))
}

export function finalizeCurrencySettlement(expenses: CurrencyExpense[], memberIds: string[], draw?: (max: number) => number) {
  const results = currencyGroups(expenses).map(([currency, items]) => ({ currency, result: finalizeSettlement(items, memberIds, draw) }))
  return {
    shares: results.flatMap(({ result }) => result.shares),
    balances: results.flatMap(({ currency, result }) => result.balances.map(balance => ({ ...balance, currency }))),
    transfers: results.flatMap(({ currency, result }) => result.transfers.map(transfer => ({ ...transfer, currency }))),
  }
}

export function previewCurrencySettlement(expenses: CurrencyExpense[], memberIds: string[]) {
  const results = currencyGroups(expenses).map(([currency, items]) => ({ currency, result: previewSettlement(items, memberIds) }))
  return {
    transfers: results.flatMap(({ currency, result }) => result.transfers.map(transfer => ({ ...transfer, currency }))),
    pendingRemainders: results.map(({ currency, result }) => ({ currency, amountMinor: result.pendingRemainderMinor })),
  }
}
