import 'server-only'
import type { Currency, Expense, RoundStatus } from '../../Shared'

export type RoundRow = {
  id: string; group_id: string; creator_id: string; name: string; currency: Currency; status: RoundStatus;
  version: number; created_at: string; finalized_at: string | null; completed_at: string | null;
  group_name: string; group_creator_id: string; is_creator: boolean;
  balance_minor?: string; total_minor?: string; member_count?: string | number
}
export type MemberRow = { user_id: string; display_name_snapshot: string; excluded_at: string | null; profile_image_url: string | null }
export type ExpenseRow = {
  id: string; round_id: string; author_id: string; payer_id: string; description: string; amount_minor: string;
  split_mode: Expense['splitMode']; base_share_minor: string | null; remainder_units: number | null;
  created_at: string; updated_at: string
}
export type ShareRow = {
  expense_id: string; user_id: string; assigned_amount_minor: string | null;
  final_amount_minor: string | null; received_remainder: boolean | null
}
export type ReceiptRow = { id: string; expense_id: string; mime_type: string; byte_size: number; object_key: string | null }
export type ExclusionExpenseRow = {
  id: string; description: string; amount_minor: string; author_id: string; author_name: string; reason: string
}
export type OutgoingRow = {
  receiver_id: string; amount_minor: string; display_name_snapshot: string; profile_image_url: string | null;
  bank_name: string | null; account_number: string | null; account_number_formatted: string | null;
  account_holder: string | null; bank_verified_at: string | null
}
export type IncomingRow = {
  sender_id: string; amount_minor: string; received_at: string | null; display_name_snapshot: string; profile_image_url: string | null
}
