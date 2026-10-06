import type { Currency } from '../money'

export type RoundStatus = 'RECORDING' | 'CONFIRMED' | 'LOCKED' | 'COMPLETED'
import type { Member } from '../../../../lib/domain-types'
export type RoundMember = Member & { profileImageUrl: string | null }
export type CurrencyTotal = { currency: Currency; totalMinor: string; balanceMinor: string | null }
export type CurrencyBalance = { currency: Currency; balanceMinor: string }
export type RoundSummary = {
  id: string; groupId: string; groupName: string; name: string; status: RoundStatus;
  version: number; createdAt: number; finalizedAt: number | null; completedAt: number | null;
  totals: CurrencyTotal[]; memberCount: number
}
export type Receipt = { id: string; mimeType: string; byteSize: number; storageStatus: 'PENDING' | 'READY' | 'FAILED' }
export type Expense = {
  id: string; authorId: string; payerId: string; description: string; currency: Currency; amountMinor: string;
  splitMode: 'ALL' | 'SELECTED' | 'CUSTOM'; participantIds: string[]; baseShareMinor: string | null; remainderUnits: number | null;
  shares: { userId: string; assignedAmountMinor: string | null; amountMinor: string | null; receivedRemainder: boolean | null }[];
  receipts: Receipt[]; createdAt: number; updatedAt: number
}
export type SettlementTransfer = { currency: Currency; senderId: string; receiverId: string; amountMinor: string }
export type RoundDetail = RoundSummary & {
  creatorId: string; groupCreatorId: string; isCreator: boolean; members: RoundMember[]; expenses: Expense[];
  expensesNextCursor: string | null; transfers: SettlementTransfer[]; pendingRemainders: { currency: Currency; amountMinor: string }[]
}
export type ExclusionCheck = {
  allowed: boolean; reason: string | null;
  expenses: { id: string; description: string; currency: Currency; amountMinor: string; authorId: string; authorName: string; reason: string }[]
}
export type MutationResult = { id: string; roundId?: string; status?: RoundStatus; version?: number; inviteId?: string; sharePath?: string; linkUnavailable?: boolean }
export type SettlementDTO = {
  roundId: string; name: string; groupName: string; status: RoundStatus; version: number; isCreator: boolean;
  finalized: boolean; balances: CurrencyBalance[]; sharePath: string | null;
  checkedAt: number | null; checkRequired: boolean; checkedCount: number; requiredCount: number; allChecked: boolean;
  confirmations: { userId: string; displayName: string; profileImageUrl: string | null; checkedAt: number | null }[];
  outgoing: { currency: Currency; receiverId: string; displayName: string; profileImageUrl: string | null; amountMinor: string; account?: { bankName: string | null; accountNumber: string | null; formattedAccountNumber: string | null; accountHolder: string | null; verifiedAt: number | null } }[];
  incoming: { currency: Currency; senderId: string; displayName: string; profileImageUrl: string | null; amountMinor: string; receivedAt: number | null }[]
}

export type UnfinishedUserRound = { id: string; name: string; status: RoundStatus; groupId: string; groupName: string }
export type CreateRoundRequestDTO = { name: string; participantIds: string[] }
export type VersionRequestDTO = { expectedVersion: number }
export type ExpenseRequestDTO = VersionRequestDTO & { currency?: Currency; description?: string; amount?: string; payerId?: string; splitMode?: Expense['splitMode']; participantIds?: string[]; customShares?: { userId: string; amount: string }[] }
export type SettlementCheckRequestDTO = VersionRequestDTO & { checked: boolean; senderId?: string; currency?: Currency }
