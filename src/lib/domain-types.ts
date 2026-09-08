import type { Currency } from './money'

export type RoundStatus = 'RECORDING' | 'CONFIRMED' | 'LOCKED' | 'COMPLETED'
export type Page<T> = { items: T[]; nextCursor: string | null }
export type Member = { userId: string; displayName: string; excludedAt: number | null }
export type GroupSummary = { id: string; name: string; creatorId: string; createdAt: number }
export type GroupDetail = GroupSummary & { members: Member[]; isCreator: boolean; invites: { id: string; expiresAt: number }[] }
export type RoundSummary = {
  id: string; groupId: string; groupName: string; name: string; currency: Currency; status: RoundStatus;
  version: number; createdAt: number; finalizedAt: number | null; completedAt: number | null;
  balanceMinor: string | null; totalMinor: string; memberCount: number
}
export type Receipt = { id: string; mimeType: string; byteSize: number }
export type Expense = {
  id: string; authorId: string; payerId: string; description: string; amountMinor: string;
  splitMode: 'ALL' | 'SELECTED'; participantIds: string[]; baseShareMinor: string | null; remainderUnits: number | null;
  shares: { userId: string; amountMinor: string | null; receivedRemainder: boolean | null }[];
  receipts: Receipt[]; createdAt: number; updatedAt: number
}
export type RoundDetail = RoundSummary & { creatorId: string; isCreator: boolean; members: Member[]; expenses: Expense[]; expensesNextCursor: string | null }
export type ExclusionCheck = {
  allowed: boolean; reason: string | null;
  expenses: { id: string; description: string; amountMinor: string; authorId: string; authorName: string; reason: string }[]
}
export type MutationResult = { id: string; roundId?: string; status?: RoundStatus; version?: number; inviteId?: string; sharePath?: string; linkUnavailable?: boolean }
export type SettlementDTO = {
  roundId: string; name: string; groupName: string; status: RoundStatus; version: number; isCreator: boolean;
  finalized: boolean; currency: Currency; balanceMinor: string | null; sharePath: string | null;
  outgoing: { receiverId: string; displayName: string; amountMinor: string; account?: { bankName: string | null; accountNumber: string | null; accountHolder: string | null } }[];
  incoming: { senderId: string; displayName: string; amountMinor: string }[]
}
