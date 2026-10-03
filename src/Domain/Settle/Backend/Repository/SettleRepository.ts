import 'server-only'
import type { Database } from '../../../../Global/Util/Backend'
import type { Currency, Expense } from '../../Shared'
import type { RoundRow, MemberRow, ExpenseRow, ShareRow, ReceiptRow, ExclusionExpenseRow, OutgoingRow, IncomingRow } from '../DAO/SettleDAO'

export function findRound(client: Database, id: string, userId: string) {
  return client.query<RoundRow>(`SELECT r.*,g.name AS group_name,g.creator_id AS group_creator_id,
    (r.creator_id=$2) AS is_creator
    FROM rounds r JOIN groups g ON g.id=r.group_id JOIN round_members m ON m.round_id=r.id AND m.user_id=$2 WHERE r.id=$1`, [id, userId])
}

export function bumpRound(client: Database, id: string) {
  return client.query<Pick<RoundRow, 'id' | 'status' | 'version'>>('UPDATE rounds SET version=version+1 WHERE id=$1 RETURNING id,status,version', [id])
}

export function findMembers(client: Database, roundId: string) {
  return client.query<MemberRow>(`SELECT rm.user_id,rm.display_name_snapshot,rm.excluded_at,
    CASE WHEN u.deleted_at IS NULL THEN u.profile_image_url ELSE NULL END AS profile_image_url
    FROM round_members rm JOIN users u ON u.id=rm.user_id WHERE rm.round_id=$1 ORDER BY rm.user_id`, [roundId])
}

export function findExpenses(client: Database, roundId: string, createdAt: string | null, cursorId: string | null, limit: number | null) {
  return client.query<ExpenseRow>(`SELECT * FROM expenses WHERE round_id=$1 AND ($2::bigint IS NULL OR (created_at,id)<($2::bigint,$3::text)) ORDER BY created_at DESC,id DESC LIMIT $4`, [roundId, createdAt, cursorId, limit])
}

export function findShares(client: Database, ids: string[]) {
  return client.query<ShareRow>('SELECT * FROM expense_shares WHERE expense_id=ANY($1::text[]) ORDER BY user_id', [ids])
}

export function findReceipts(client: Database, ids: string[]) {
  return client.query<Pick<ReceiptRow, 'id' | 'expense_id' | 'mime_type' | 'byte_size'>>('SELECT id,expense_id,mime_type,byte_size FROM expense_receipts WHERE expense_id=ANY($1::text[]) ORDER BY created_at,id', [ids])
}

export function findSettlementExpenses(client: Database, roundId: string) {
  return client.query<Pick<ExpenseRow, 'id' | 'payer_id' | 'amount_minor' | 'split_mode'> & { participant_ids: string[]; shares: { userId: string; assignedAmountMinor: string | null }[] | null }>(`SELECT e.id,e.payer_id,e.amount_minor,e.split_mode,
    ARRAY(SELECT s.user_id FROM expense_shares s WHERE s.expense_id=e.id ORDER BY s.user_id) AS participant_ids,
    (SELECT json_agg(json_build_object('userId',s.user_id,'assignedAmountMinor',s.assigned_amount_minor::text) ORDER BY s.user_id)
      FROM expense_shares s WHERE s.expense_id=e.id) AS shares
    FROM expenses e WHERE e.round_id=$1 ORDER BY e.id`, [roundId])
}

export function findSettlementChecks(client: Database, roundId: string) {
  return client.query<Omit<MemberRow, 'excluded_at'> & { checked_at: string | null }>(`SELECT rm.user_id,rm.display_name_snapshot,
    CASE WHEN bool_and(t.received_at IS NOT NULL) THEN max(t.received_at) ELSE NULL END AS checked_at,
    CASE WHEN u.deleted_at IS NULL THEN u.profile_image_url ELSE NULL END AS profile_image_url
    FROM settlement_transfers t JOIN round_members rm ON rm.round_id=t.round_id AND rm.user_id=t.receiver_id
    JOIN users u ON u.id=rm.user_id WHERE t.round_id=$1
    GROUP BY rm.user_id,rm.display_name_snapshot,u.deleted_at,u.profile_image_url ORDER BY rm.user_id`, [roundId])
}

export function findRounds(client: Database, userId: string, groupId: string | null, status: string | null, search: string | null, createdAt: string | null, cursorId: string | null, limit: number) {
  return client.query<RoundRow>(`SELECT r.*,g.name AS group_name,b.balance_minor,
      (SELECT COALESCE(sum(amount_minor),0)::text FROM expenses WHERE round_id=r.id) AS total_minor,
      (SELECT count(*) FROM round_members WHERE round_id=r.id AND excluded_at IS NULL) AS member_count
      FROM rounds r JOIN groups g ON g.id=r.group_id JOIN round_members m ON m.round_id=r.id AND m.user_id=$1
      LEFT JOIN settlement_balances b ON b.round_id=r.id AND b.user_id=$1
      WHERE ($2::text IS NULL OR r.group_id=$2) AND ($3::text IS NULL OR ($3='active' AND r.status<>'COMPLETED') OR r.status=$3)
      AND ($4::text IS NULL OR strpos(lower(r.name),lower($4))>0 OR strpos(lower(g.name),lower($4))>0)
      AND ($5::bigint IS NULL OR (r.created_at,r.id)<($5::bigint,$6::text)) ORDER BY r.created_at DESC,r.id DESC LIMIT $7`, [userId, groupId, status, search, createdAt, cursorId, limit])
}

export function findTotal(client: Database, roundId: string) {
  return client.query<{ total_minor: string }>('SELECT COALESCE(sum(amount_minor),0)::text AS total_minor FROM expenses WHERE round_id=$1', [roundId])
}

export function findBalance(client: Database, roundId: string, userId: string) {
  return client.query<{ balance_minor: string }>('SELECT balance_minor FROM settlement_balances WHERE round_id=$1 AND user_id=$2', [roundId, userId])
}

export function findViewerTransfers(client: Database, roundId: string, userId: string) {
  return client.query<{ sender_id: string; receiver_id: string; amount_minor: string }>('SELECT sender_id,receiver_id,amount_minor FROM settlement_transfers WHERE round_id=$1 AND (sender_id=$2 OR receiver_id=$2) ORDER BY sender_id,receiver_id', [roundId, userId])
}

export function insertRound(client: Database, id: string, groupId: string, userId: string, name: string, currency: Currency, now: number) {
  return client.query('INSERT INTO rounds(id,group_id,creator_id,name,currency,status,version,created_at) VALUES($1,$2,$3,$4,$5,\'RECORDING\',1,$6)', [id, groupId, userId, name, currency, now])
}

export function insertMember(client: Database, id: string, memberId: string, memberName: string, now: number) {
  return client.query('INSERT INTO round_members(round_id,user_id,display_name_snapshot,joined_at) VALUES($1,$2,$3,$4)', [id, memberId, memberName, now])
}

export function findExpense(client: Database, expenseId: string, roundId: string) {
  return client.query<ExpenseRow>('SELECT * FROM expenses WHERE id=$1 AND round_id=$2', [expenseId, roundId])
}

export function findActiveMember(client: Database, roundId: string, userId: string) {
  return client.query('SELECT 1 FROM round_members WHERE round_id=$1 AND user_id=$2 AND excluded_at IS NULL', [roundId, userId])
}

export function findAssignedShares(client: Database, expenseId: string) {
  return client.query<Pick<ShareRow, 'user_id' | 'assigned_amount_minor'>>('SELECT user_id,assigned_amount_minor FROM expense_shares WHERE expense_id=$1 ORDER BY user_id', [expenseId])
}

export function findShareMembers(client: Database, expenseId: string) {
  return client.query<{ user_id: string }>('SELECT user_id FROM expense_shares WHERE expense_id=$1 ORDER BY user_id', [expenseId])
}

export function deleteShares(client: Database, expenseId: string) {
  return client.query('DELETE FROM expense_shares WHERE expense_id=$1', [expenseId])
}

export function insertShares(client: Database, expenseId: string, roundId: string, ids: string[], amounts: (string | null)[]) {
  return client.query('INSERT INTO expense_shares(expense_id,round_id,user_id,assigned_amount_minor) SELECT $1,$2,unnest($3::text[]),unnest($4::numeric[])', [expenseId, roundId, ids, amounts])
}

export function updateExpense(client: Database, id: string, description: string, amount: string, payerId: string, splitMode: Expense['splitMode'], now: number, userId: string) {
  return client.query('UPDATE expenses SET description=$2,amount_minor=$3,payer_id=$4,split_mode=$5,base_share_minor=NULL,remainder_units=NULL,updated_at=$6,updated_by=$7 WHERE id=$1', [id, description, amount, payerId, splitMode, now, userId])
}

export function insertExpense(client: Database, id: string, roundId: string, userId: string, payerId: string, description: string, amount: string, splitMode: Expense['splitMode'], now: number) {
  return client.query('INSERT INTO expenses(id,round_id,author_id,payer_id,description,amount_minor,split_mode,created_at,updated_at,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$3)', [id, roundId, userId, payerId, description, amount, splitMode, now])
}

export function findExpenseObjects(client: Database, expenseId: string) {
  return client.query<{ object_key: string }>('SELECT object_key FROM expense_receipts WHERE expense_id=$1 AND object_key IS NOT NULL', [expenseId])
}

export function deleteExpense(client: Database, expenseId: string) {
  return client.query('DELETE FROM expenses WHERE id=$1', [expenseId])
}

export function findExclusionExpenses(client: Database, roundId: string, targetId: string) {
  return client.query<ExclusionExpenseRow>(`SELECT e.id,e.description,e.amount_minor,e.author_id,a.display_name_snapshot AS author_name,
    CASE WHEN e.payer_id=$2 THEN 'payer_and_participant' WHEN e.split_mode='CUSTOM' THEN 'custom_participant' ELSE 'selected_participant' END AS reason
    FROM expenses e JOIN expense_shares s ON s.expense_id=e.id AND s.user_id=$2
    JOIN round_members a ON a.round_id=e.round_id AND a.user_id=e.author_id
    WHERE e.round_id=$1 AND (e.payer_id=$2 OR e.split_mode IN ('SELECTED','CUSTOM')) ORDER BY e.created_at,e.id`, [roundId, targetId])
}

export function excludeMember(client: Database, roundId: string, targetId: string, now: number) {
  return client.query('UPDATE round_members SET excluded_at=$3 WHERE round_id=$1 AND user_id=$2', [roundId, targetId, now])
}

export function removeAllShareMember(client: Database, roundId: string, targetId: string) {
  return client.query("DELETE FROM expense_shares s USING expenses e WHERE s.expense_id=e.id AND e.round_id=$1 AND e.split_mode='ALL' AND s.user_id=$2", [roundId, targetId])
}

export function saveFinalShare(client: Database, expenseId: string, userId: string, amountMinor: string, receivedRemainder: boolean) {
  return client.query('UPDATE expense_shares SET final_amount_minor=$3,received_remainder=$4 WHERE expense_id=$1 AND user_id=$2', [expenseId, userId, amountMinor, receivedRemainder])
}

export function insertBalance(client: Database, roundId: string, userId: string, paidMinor: string, burdenMinor: string, balanceMinor: string) {
  return client.query('INSERT INTO settlement_balances(round_id,user_id,paid_minor,burden_minor,balance_minor) VALUES($1,$2,$3,$4,$5)', [roundId, userId, paidMinor, burdenMinor, balanceMinor])
}

export function insertTransfer(client: Database, roundId: string, senderId: string, receiverId: string, amountMinor: string) {
  return client.query('INSERT INTO settlement_transfers(round_id,sender_id,receiver_id,amount_minor) VALUES($1,$2,$3,$4)', [roundId, senderId, receiverId, amountMinor])
}

export function finalizeRound(client: Database, roundId: string, now: number) {
  return client.query('UPDATE rounds SET finalized_at=$2 WHERE id=$1', [roundId, now])
}

export function saveBaseShare(client: Database, expenseId: string, baseMinor: string, remainder: number) {
  return client.query('UPDATE expenses SET base_share_minor=$2,remainder_units=$3 WHERE id=$1', [expenseId, baseMinor, remainder])
}

export function confirmRound(client: Database, roundId: string, now: number) {
  return client.query("UPDATE rounds SET status='CONFIRMED',confirmed_at=$2 WHERE id=$1", [roundId, now])
}

export function clearBaseShares(client: Database, roundId: string) {
  return client.query('UPDATE expenses SET base_share_minor=NULL,remainder_units=NULL WHERE round_id=$1', [roundId])
}

export function reopenRound(client: Database, roundId: string) {
  return client.query("UPDATE rounds SET status='RECORDING',confirmed_at=NULL WHERE id=$1", [roundId])
}

export function lockRound(client: Database, roundId: string, now: number) {
  return client.query("UPDATE rounds SET status='LOCKED',locked_at=$2 WHERE id=$1", [roundId, now])
}

export function findRemainder(client: Database, roundId: string) {
  return client.query('SELECT 1 FROM expenses WHERE round_id=$1 AND remainder_units>0 LIMIT 1', [roundId])
}

export function countPendingTransfers(client: Database, roundId: string) {
  return client.query<{ count: number }>('SELECT count(*)::int AS count FROM settlement_transfers WHERE round_id=$1 AND received_at IS NULL', [roundId])
}

export function completeRound(client: Database, roundId: string, now: number) {
  return client.query("UPDATE rounds SET status='COMPLETED',completed_at=$2 WHERE id=$1", [roundId, now])
}

export function findRoundObjects(client: Database, roundId: string) {
  return client.query<{ object_key: string }>('SELECT object_key FROM expense_receipts WHERE expense_id IN (SELECT id FROM expenses WHERE round_id=$1) AND object_key IS NOT NULL', [roundId])
}

export function deleteRound(client: Database, roundId: string) {
  return client.query('DELETE FROM rounds WHERE id=$1', [roundId])
}

export function setReceived(client: Database, roundId: string, userId: string, senderId: string | null, checked: boolean, now: number) {
  return client.query(`UPDATE settlement_transfers SET received_at=CASE
      WHEN $4 THEN COALESCE(received_at,$5) ELSE NULL END
      WHERE round_id=$1 AND receiver_id=$2 AND ($3::text IS NULL OR sender_id=$3)`, [roundId, userId, senderId, checked, now])
}

export function findOutgoing(client: Database, roundId: string, userId: string, currency: Currency) {
  // Bank fields are selected only for the viewer's actual KRW recipients.
  const bankFields = currency === 'KRW' ? ',u.bank_name,u.account_number,u.account_number_formatted,u.account_holder,u.bank_verified_at' : ''
  return client.query<OutgoingRow>(`SELECT t.receiver_id,t.amount_minor,m.display_name_snapshot,
      CASE WHEN u.deleted_at IS NULL THEN u.profile_image_url ELSE NULL END AS profile_image_url${bankFields} FROM settlement_transfers t
      JOIN round_members m ON m.round_id=t.round_id AND m.user_id=t.receiver_id JOIN users u ON u.id=t.receiver_id
      WHERE t.round_id=$1 AND t.sender_id=$2 AND t.received_at IS NULL ORDER BY t.receiver_id`, [roundId, userId])
}

export function findIncoming(client: Database, roundId: string, userId: string) {
  return client.query<IncomingRow>(`SELECT t.sender_id,t.amount_minor,t.received_at,m.display_name_snapshot,
      CASE WHEN u.deleted_at IS NULL THEN u.profile_image_url ELSE NULL END AS profile_image_url FROM settlement_transfers t
      JOIN round_members m ON m.round_id=t.round_id AND m.user_id=t.sender_id JOIN users u ON u.id=t.sender_id
      WHERE t.round_id=$1 AND t.receiver_id=$2 ORDER BY t.sender_id`, [roundId, userId])
}

export function insertReceipt(client: Database, id: string, expenseId: string, userId: string, mimeType: string, byteSize: number, sha256: string, objectKey: string, now: number) {
  return client.query('INSERT INTO expense_receipts(id,expense_id,uploaded_by,mime_type,byte_size,sha256,object_key,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [id, expenseId, userId, mimeType, byteSize, sha256, objectKey, now])
}

export function deleteReceipt(client: Database, receiptId: string, expenseId: string) {
  return client.query<{ object_key: string | null }>('DELETE FROM expense_receipts WHERE id=$1 AND expense_id=$2 RETURNING object_key', [receiptId, expenseId])
}

export function findReceipt(client: Database, receiptId: string, userId: string) {
  return client.query<Pick<ReceiptRow, 'mime_type' | 'object_key'>>(`SELECT r.mime_type,r.object_key FROM expense_receipts r JOIN expenses e ON e.id=r.expense_id
      JOIN round_members m ON m.round_id=e.round_id AND m.user_id=$2 WHERE r.id=$1`, [receiptId, userId])
}

export function findLegacyReceipt(client: Database, receiptId: string) {
  return client.query<{ content: Uint8Array }>('SELECT content FROM expense_receipts WHERE id=$1', [receiptId])
}
