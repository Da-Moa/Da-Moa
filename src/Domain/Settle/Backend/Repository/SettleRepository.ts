import 'server-only'
import type { Database } from '../../../../Global/Util/Backend'
import { roundCreationCandidatesSql } from '../../../Group/Backend'
import type { Currency, Expense, MutationResult, finalizeSettlement } from '../../Shared'
import type { RoundRow, RoundDetailRow, RoundConfirmationRow, RoundCompletionRow, RoundForceCompletionRow, ExpenseUpdateRow, ExpenseDeletionRow, MemberExclusionRow, MemberRow, ExpenseRow, ShareRow, ReceiptContentRow, ReceiptCreationRow, ReceiptDeletionRow, SettlementExpenseRow, SettlementCheckRow, SettlementRow } from '../DAO/SettleDAO'

export function findRound(client: Database, id: string, userId: string) {
  return client.query<RoundRow>(`SELECT r.*,g.name AS group_name,g.creator_id AS group_creator_id,
    (r.creator_id=$2) AS is_creator
    FROM rounds r JOIN groups g ON g.id=r.group_id JOIN round_members m ON m.round_id=r.id AND m.user_id=$2 WHERE r.id=$1`, [id, userId])
}

export function findRoundDetail(client: Database, id: string, userId: string, createdAt: string | null, cursorId: string | null, limit: number) {
  return client.query<RoundDetailRow>(`SELECT r.*,g.name AS group_name,g.creator_id AS group_creator_id,
    (r.creator_id=$2) AS is_creator,b.balance_minor,
    (SELECT COALESCE(sum(amount_minor),0)::text FROM expenses WHERE round_id=r.id) AS total_minor,
    COALESCE(members.items,'[]'::jsonb) AS members,COALESCE(page.items,'[]'::jsonb) AS expenses,
    COALESCE(preview.items,'[]'::jsonb) AS settlement_expenses,COALESCE(transfers.items,'[]'::jsonb) AS transfers
    FROM rounds r JOIN groups g ON g.id=r.group_id JOIN round_members viewer ON viewer.round_id=r.id AND viewer.user_id=$2
    LEFT JOIN settlement_balances b ON b.round_id=r.id AND b.user_id=$2
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('user_id',rm.user_id,'display_name_snapshot',rm.display_name_snapshot,
        'excluded_at',rm.excluded_at::text,'profile_image_url',CASE WHEN u.deleted_at IS NULL THEN u.profile_image_url ELSE NULL END)
        ORDER BY rm.user_id) AS items FROM round_members rm JOIN users u ON u.id=rm.user_id WHERE rm.round_id=r.id
    ) members ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(to_jsonb(e) || jsonb_build_object('amount_minor',e.amount_minor::text,'base_share_minor',e.base_share_minor::text,
        'created_at',e.created_at::text,'updated_at',e.updated_at::text,
        'shares',COALESCE((SELECT jsonb_agg(jsonb_build_object('user_id',s.user_id,'assigned_amount_minor',s.assigned_amount_minor::text,
          'final_amount_minor',s.final_amount_minor::text,'received_remainder',s.received_remainder) ORDER BY s.user_id)
          FROM expense_shares s WHERE s.expense_id=e.id),'[]'::jsonb),
        'receipts',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',rc.id,'mime_type',rc.mime_type,'byte_size',rc.byte_size)
          ORDER BY rc.created_at,rc.id) FROM expense_receipts rc WHERE rc.expense_id=e.id),'[]'::jsonb))
        ORDER BY e.created_at DESC,e.id DESC) AS items
      FROM (SELECT * FROM expenses WHERE round_id=r.id AND ($3::bigint IS NULL OR (created_at,id)<($3::bigint,$4::text))
        ORDER BY created_at DESC,id DESC LIMIT $5) e
    ) page ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('id',e.id,'payer_id',e.payer_id,'amount_minor',e.amount_minor::text,'split_mode',e.split_mode,
        'participant_ids',ARRAY(SELECT s.user_id FROM expense_shares s WHERE s.expense_id=e.id ORDER BY s.user_id),
        'shares',(SELECT jsonb_agg(jsonb_build_object('userId',s.user_id,'assignedAmountMinor',s.assigned_amount_minor::text) ORDER BY s.user_id)
          FROM expense_shares s WHERE s.expense_id=e.id)) ORDER BY e.id) AS items
      FROM expenses e WHERE e.round_id=r.id AND r.finalized_at IS NULL
    ) preview ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('sender_id',t.sender_id,'receiver_id',t.receiver_id,'amount_minor',t.amount_minor::text)
        ORDER BY t.sender_id,t.receiver_id) AS items FROM settlement_transfers t
      WHERE t.round_id=r.id AND r.finalized_at IS NOT NULL AND (t.sender_id=$2 OR t.receiver_id=$2)
    ) transfers ON true WHERE r.id=$1`, [id, userId, createdAt, cursorId, limit])
}

export function bumpRound(client: Database, id: string, expectedVersion: number) {
  return client.query<Pick<RoundRow, 'id' | 'status' | 'version'>>('UPDATE rounds SET version=version+1 WHERE id=$1 AND version=$2 RETURNING id,status,version', [id, expectedVersion])
}

export function findMembers(client: Database, roundId: string) {
  return client.query<MemberRow>(`SELECT rm.user_id,rm.display_name_snapshot,rm.excluded_at,
    CASE WHEN u.deleted_at IS NULL THEN u.profile_image_url ELSE NULL END AS profile_image_url
    FROM round_members rm JOIN users u ON u.id=rm.user_id WHERE rm.round_id=$1 ORDER BY rm.user_id`, [roundId])
}

export function findSettlementExpenses(client: Database, roundId: string) {
  return client.query<SettlementExpenseRow>(`SELECT e.id,e.payer_id,e.amount_minor,e.split_mode,
    ARRAY(SELECT s.user_id FROM expense_shares s WHERE s.expense_id=e.id ORDER BY s.user_id) AS participant_ids,
    (SELECT json_agg(json_build_object('userId',s.user_id,'assignedAmountMinor',s.assigned_amount_minor::text) ORDER BY s.user_id)
      FROM expense_shares s WHERE s.expense_id=e.id) AS shares
    FROM expenses e WHERE e.round_id=$1 ORDER BY e.id`, [roundId])
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

export async function insertRound(client: Database, id: string, groupId: string, userId: string, name: string, currency: Currency, now: number, ids: string[]) {
  return (await client.query<{ actor_active: boolean; is_member: boolean; created: boolean }>(`${roundCreationCandidatesSql}, created AS (
    INSERT INTO rounds(id,group_id,creator_id,name,currency,status,version,created_at)
    SELECT $3,$1,actor.id,$5,$6,'RECORDING',1,$7 FROM actor
    WHERE actor.is_member AND (SELECT count(*) FROM candidates)=cardinality($2::text[])
    RETURNING id
  ), members AS (
    INSERT INTO round_members(round_id,user_id,display_name_snapshot,joined_at)
    SELECT created.id,candidates.id,candidates.name,$7 FROM created CROSS JOIN candidates
    RETURNING user_id
  ) SELECT EXISTS(SELECT 1 FROM actor) AS actor_active,
    COALESCE((SELECT is_member FROM actor),false) AS is_member,
    EXISTS(SELECT 1 FROM members) AS created`, [groupId, ids, id, userId, name, currency, now])).rows[0]
}

export function findExpenseUpdate(client: Database, roundId: string, expenseId: string, userId: string, key: string) {
  return client.query<ExpenseUpdateRow>(`WITH context AS (
    SELECT r.*,(r.creator_id=$3) AS is_creator,
      to_jsonb(e) || jsonb_build_object('amount_minor',e.amount_minor::text) AS expense,
      ARRAY(SELECT user_id FROM round_members WHERE round_id=r.id AND excluded_at IS NULL ORDER BY user_id) AS active_ids,
      ARRAY(SELECT user_id FROM round_members WHERE round_id=r.id ORDER BY user_id) AS user_ids,
      (SELECT COALESCE(sum(amount_minor),0)::text FROM expenses WHERE round_id=r.id) AS total_minor,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('user_id',s.user_id,'assigned_amount_minor',s.assigned_amount_minor::text) ORDER BY s.user_id)
        FROM expense_shares s WHERE s.expense_id=e.id),'[]'::jsonb) AS shares
    FROM rounds r JOIN round_members viewer ON viewer.round_id=r.id AND viewer.user_id=$3
    LEFT JOIN expenses e ON e.round_id=r.id AND e.id=$2 WHERE r.id=$1
  ), saved AS (
    SELECT request_digest,response_metadata FROM mutation_requests WHERE actor_id=$3 AND operation='expense.update' AND request_key=$4
  ) SELECT context.*,saved.request_digest,saved.response_metadata FROM (SELECT 1) anchor
    LEFT JOIN context ON true LEFT JOIN saved ON true`, [roundId, expenseId, userId, key])
}

export async function updateExpense(client: Database, id: string, roundId: string, userId: string, key: string, digest: string,
  input: { description: string; amount: string; payerId: string; splitMode: Expense['splitMode']; participantIds: string[] },
  amounts: (string | null)[], expectedVersion: number, maximumTotal: string, now: number) {
  const { rows } = await client.query<{ response_metadata: MutationResult }>(`WITH eligible AS MATERIALIZED (
    SELECT e.id FROM expenses e JOIN rounds r ON r.id=e.round_id
    JOIN round_members viewer ON viewer.round_id=r.id AND viewer.user_id=$3
    JOIN users actor ON actor.id=$3 AND actor.deleted_at IS NULL AND actor.onboarding_completed_at IS NOT NULL
    WHERE e.id=$1 AND r.id=$2 AND (r.creator_id=$3 OR (viewer.excluded_at IS NULL AND e.author_id=$3))
      AND EXISTS(SELECT 1 FROM round_members WHERE round_id=r.id AND user_id=$9 AND (excluded_at IS NULL OR user_id=e.payer_id))
      AND cardinality($11::text[])>0 AND NOT EXISTS(SELECT 1 FROM unnest($11::text[]) AS selected(user_id)
        WHERE NOT EXISTS(SELECT 1 FROM round_members WHERE round_id=r.id AND user_id=selected.user_id AND excluded_at IS NULL))
      AND (SELECT COALESCE(sum(amount_minor),0) FROM expenses WHERE round_id=r.id AND id<>e.id)+$8::numeric<=$14::numeric
      AND NOT EXISTS(SELECT 1 FROM mutation_requests WHERE actor_id=$3 AND operation='expense.update' AND request_key=$4)
  ), bumped AS (
    UPDATE rounds SET version=version+1 WHERE id=$2 AND version=$13 AND status='RECORDING' AND completed_at IS NULL
      AND EXISTS(SELECT 1 FROM eligible) RETURNING status,version
  ), updated AS (
    UPDATE expenses SET description=$7,amount_minor=$8,payer_id=$9,split_mode=$10,
      base_share_minor=NULL,remainder_units=NULL,updated_at=$6,updated_by=$3
    WHERE id=$1 AND round_id=$2 AND EXISTS(SELECT 1 FROM bumped) RETURNING id
  ), removed AS (
    DELETE FROM expense_shares WHERE expense_id IN (SELECT id FROM updated) AND NOT (user_id=ANY($11::text[])) RETURNING user_id
  ), shares AS (
    INSERT INTO expense_shares(expense_id,round_id,user_id,assigned_amount_minor)
    SELECT updated.id,$2,selected.user_id,selected.amount FROM updated CROSS JOIN unnest($11::text[],$12::numeric[]) AS selected(user_id,amount)
    ON CONFLICT (expense_id,user_id) DO UPDATE SET assigned_amount_minor=EXCLUDED.assigned_amount_minor,
      final_amount_minor=NULL,received_remainder=NULL RETURNING user_id
  ) INSERT INTO mutation_requests(actor_id,operation,request_key,request_digest,resource_id,response_metadata,created_at)
    SELECT $3,'expense.update',$4,$5,$1,jsonb_build_object('id',$1::text,'roundId',$2::text,'status',bumped.status,'version',bumped.version),$6
    FROM bumped WHERE EXISTS(SELECT 1 FROM shares) RETURNING response_metadata`,
  [id, roundId, userId, key, digest, now, input.description, input.amount, input.payerId, input.splitMode, input.participantIds, amounts, expectedVersion, maximumTotal])
  return rows[0]?.response_metadata ?? null
}

export async function insertExpenseCreation(client: Database, id: string, roundId: string, userId: string, key: string,
  input: { description: string; amount: string; payerId: string; splitMode: Expense['splitMode']; participantIds: string[] },
  expectedVersion: number, hasDecimal: boolean, scales: Record<string, string>, maximumExpense: string, maximumTotal: string, now: number) {
  return (await client.query<RoundRow & { actor_active: boolean; active_ids: string[]; user_ids: string[]; total_minor: string; created: boolean; request_digest: string | null; response_metadata: unknown }>(`WITH context AS (
    SELECT r.*,(r.creator_id=$3) AS is_creator,
      ARRAY(SELECT user_id FROM round_members WHERE round_id=r.id AND excluded_at IS NULL ORDER BY user_id) AS active_ids,
      ARRAY(SELECT user_id FROM round_members WHERE round_id=r.id ORDER BY user_id) AS user_ids,
      (SELECT COALESCE(sum(amount_minor),0)::text FROM expenses WHERE round_id=r.id) AS total_minor,
      ($11::jsonb->>r.currency)::numeric AS scale
    FROM rounds r JOIN round_members viewer ON viewer.round_id=r.id AND viewer.user_id=$3 WHERE r.id=$2
  ), saved AS (
    SELECT request_digest,response_metadata FROM mutation_requests WHERE actor_id=$3 AND operation='expense.create' AND request_key=$4
  ), actor AS (
    SELECT EXISTS(SELECT 1 FROM users WHERE id=$3 AND deleted_at IS NULL AND onboarding_completed_at IS NOT NULL) AS active
  ), created AS (
    INSERT INTO expenses(id,round_id,author_id,payer_id,description,amount_minor,split_mode,created_at,updated_at,updated_by)
    SELECT $1,r.id,$3,$5,$6,trunc($7::numeric*r.scale/100),$8,$15,$15,$3 FROM context r CROSS JOIN actor
    WHERE actor.active AND NOT EXISTS(SELECT 1 FROM saved) AND r.status='RECORDING' AND r.completed_at IS NULL
      AND r.version=$9 AND (r.is_creator OR $3=ANY(r.active_ids)) AND $5=ANY(r.active_ids)
      AND cardinality(r.active_ids)>0 AND ($8='ALL' OR $10::text[]<@r.active_ids)
      AND (r.scale<>1 OR NOT $12) AND $7::numeric<=$13::numeric*100
      AND r.total_minor::numeric+$7::numeric*r.scale/100<=$14::numeric*r.scale
    RETURNING id
  ) SELECT r.*,actor.active AS actor_active,saved.request_digest,saved.response_metadata,
    EXISTS(SELECT 1 FROM created) AS created FROM actor
    LEFT JOIN context r ON true LEFT JOIN saved ON true`,
  [id, roundId, userId, key, input.payerId, input.description, input.amount, input.splitMode, expectedVersion, input.participantIds, JSON.stringify(scales), hasDecimal, maximumExpense, maximumTotal, now])).rows[0]
}

export async function finishExpenseCreation(client: Database, id: string, roundId: string, userId: string, key: string, digest: string, ids: string[], amounts: (string | null)[], now: number, expectedVersion: number) {
  return (await client.query<{ response_metadata: MutationResult }>(`WITH shares AS (
    INSERT INTO expense_shares(expense_id,round_id,user_id,assigned_amount_minor)
    SELECT $1,$2,unnest($7::text[]),unnest($8::numeric[]) RETURNING user_id
  ), bumped AS (
    UPDATE rounds SET version=version+1 WHERE id=$2 AND version=$9 AND EXISTS(SELECT 1 FROM shares) RETURNING status,version
  ) INSERT INTO mutation_requests(actor_id,operation,request_key,request_digest,resource_id,response_metadata,created_at)
    SELECT $3,'expense.create',$4,$5,$1,jsonb_build_object('id',$1::text,'roundId',$2::text,'status',status,'version',version),$6 FROM bumped
    RETURNING response_metadata`, [id, roundId, userId, key, digest, now, ids, amounts, expectedVersion])).rows[0]?.response_metadata ?? null
}

const expenseDeletionContextSql = `context AS MATERIALIZED (
  SELECT r.*,(r.creator_id=$3) AS is_creator,e.id AS expense_id,e.author_id,viewer.excluded_at AS viewer_excluded_at,
    ARRAY(SELECT user_id FROM round_members WHERE round_id=r.id ORDER BY user_id) AS user_ids,
    ARRAY(SELECT object_key FROM expense_receipts WHERE expense_id=e.id AND object_key IS NOT NULL) AS object_keys
  FROM rounds r JOIN round_members viewer ON viewer.round_id=r.id AND viewer.user_id=$3
  LEFT JOIN expenses e ON e.round_id=r.id AND e.id=$2 WHERE r.id=$1
), saved AS MATERIALIZED (
  SELECT request_digest,response_metadata FROM mutation_requests WHERE actor_id=$3 AND operation='expense.delete' AND request_key=$4
), actor AS (
  SELECT EXISTS(SELECT 1 FROM users WHERE id=$3 AND deleted_at IS NULL AND onboarding_completed_at IS NOT NULL) AS active
)`

export function findExpenseDeletion(client: Database, roundId: string, expenseId: string, userId: string, key: string) {
  return client.query<ExpenseDeletionRow>(`WITH ${expenseDeletionContextSql}
    SELECT context.*,actor.active AS actor_active,saved.request_digest,saved.response_metadata FROM actor
    LEFT JOIN context ON true LEFT JOIN saved ON true`, [roundId, expenseId, userId, key])
}

export async function deleteExpense(client: Database, roundId: string, expenseId: string, userId: string, key: string, digest: string, expectedVersion: number, now: number) {
  return (await client.query<ExpenseDeletionRow>(`WITH ${expenseDeletionContextSql}, bumped AS (
    UPDATE rounds SET version=version+1 WHERE id=$1 AND version=$6 AND status='RECORDING' AND completed_at IS NULL
      AND (SELECT active FROM actor) AND NOT EXISTS(SELECT 1 FROM saved)
      AND EXISTS(SELECT 1 FROM context WHERE expense_id IS NOT NULL AND (is_creator OR (viewer_excluded_at IS NULL AND author_id=$3)))
    RETURNING status,version
  ), deleted AS (
    DELETE FROM expenses WHERE round_id=$1 AND id=$2 AND EXISTS(SELECT 1 FROM bumped) RETURNING id
  ), recorded AS (
    INSERT INTO mutation_requests(actor_id,operation,request_key,request_digest,resource_id,response_metadata,created_at)
    SELECT $3,'expense.delete',$4,$5,$2,jsonb_build_object('id',$2::text,'roundId',$1::text,'status',status,'version',version),$7
    FROM bumped WHERE EXISTS(SELECT 1 FROM deleted) RETURNING request_digest,response_metadata
  ) SELECT context.*,actor.active AS actor_active,COALESCE(recorded.request_digest,saved.request_digest) AS request_digest,
    COALESCE(recorded.response_metadata,saved.response_metadata) AS response_metadata,EXISTS(SELECT 1 FROM deleted) AS deleted
    FROM actor LEFT JOIN context ON true LEFT JOIN saved ON true LEFT JOIN recorded ON true`,
  [roundId, expenseId, userId, key, digest, expectedVersion, now])).rows[0]
}

const exclusionFields = `m.excluded_at,
    (SELECT count(*) FROM round_members WHERE round_id=$1 AND excluded_at IS NULL) AS member_count,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e.id,'description',e.description,'amount_minor',e.amount_minor::text,
      'author_id',e.author_id,'author_name',a.display_name_snapshot,'reason',
      CASE WHEN e.payer_id=$2 THEN 'payer_and_participant' WHEN e.split_mode='CUSTOM' THEN 'custom_participant' ELSE 'selected_participant' END)
      ORDER BY e.created_at,e.id)
      FROM expenses e JOIN expense_shares s ON s.expense_id=e.id AND s.user_id=$2
      JOIN round_members a ON a.round_id=e.round_id AND a.user_id=e.author_id
      WHERE e.round_id=$1 AND (e.payer_id=$2 OR e.split_mode IN ('SELECTED','CUSTOM'))),'[]'::jsonb) AS expenses`

export function findExclusionExpenses(client: Database, roundId: string, targetId: string) {
  return client.query<Pick<MemberExclusionRow, 'excluded_at' | 'member_count' | 'expenses'>>(`SELECT ${exclusionFields}
    FROM round_members m WHERE m.round_id=$1 AND m.user_id=$2`, [roundId, targetId])
}

export function findMemberExclusion(client: Database, roundId: string, targetId: string, userId: string) {
  return client.query<MemberExclusionRow>(`SELECT r.*,g.name AS group_name,g.creator_id AS group_creator_id,
    (r.creator_id=$3) AS is_creator,m.user_id AS target_id,${exclusionFields},
    ARRAY(SELECT user_id FROM round_members WHERE round_id=r.id ORDER BY user_id) AS user_ids,
    ARRAY(SELECT gm.user_id FROM group_members gm JOIN users u ON u.id=gm.user_id
      WHERE gm.group_id=r.group_id AND gm.left_at IS NULL AND u.deleted_at IS NULL ORDER BY gm.user_id) AS group_user_ids
    FROM rounds r JOIN groups g ON g.id=r.group_id JOIN round_members viewer ON viewer.round_id=r.id AND viewer.user_id=$3
    LEFT JOIN round_members m ON m.round_id=r.id AND m.user_id=$2 WHERE r.id=$1`, [roundId, targetId, userId])
}

export async function excludeMember(client: Database, roundId: string, targetId: string, userId: string, expectedVersion: number, now: number) {
  return (await client.query<MutationResult>(`WITH bumped AS (
    UPDATE rounds r SET version=version+1 WHERE r.id=$1 AND r.creator_id=$3 AND r.creator_id<>$2
      AND r.version=$4 AND r.status='RECORDING' AND r.completed_at IS NULL
      AND EXISTS(SELECT 1 FROM users WHERE id=$3 AND deleted_at IS NULL AND onboarding_completed_at IS NOT NULL)
      AND EXISTS(SELECT 1 FROM round_members WHERE round_id=r.id AND user_id=$2 AND excluded_at IS NULL)
      AND (SELECT count(*) FROM round_members WHERE round_id=r.id AND excluded_at IS NULL)>2
      AND NOT EXISTS(SELECT 1 FROM expenses e JOIN expense_shares s ON s.expense_id=e.id AND s.user_id=$2
        WHERE e.round_id=r.id AND (e.payer_id=$2 OR e.split_mode IN ('SELECTED','CUSTOM')))
    RETURNING id AS "roundId",status,version
  ), excluded AS (
    UPDATE round_members SET excluded_at=$5 WHERE round_id=$1 AND user_id=$2 AND excluded_at IS NULL
      AND EXISTS(SELECT 1 FROM bumped) RETURNING user_id
  ), removed AS (
    DELETE FROM expense_shares s USING expenses e WHERE s.expense_id=e.id AND e.round_id=$1
      AND e.split_mode='ALL' AND s.user_id IN (SELECT user_id FROM excluded)
  ) SELECT * FROM bumped WHERE EXISTS(SELECT 1 FROM excluded)`, [roundId, targetId, userId, expectedVersion, now])).rows[0]
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

const roundSettlementContextSql = (operation: 'confirm' | 'draw') => `context AS MATERIALIZED (
  SELECT r.*,(r.creator_id=$2) AS is_creator,
    ARRAY(SELECT user_id FROM round_members WHERE round_id=r.id ORDER BY user_id) AS user_ids,
    (SELECT jsonb_agg(jsonb_build_object('user_id',m.user_id,'display_name_snapshot',m.display_name_snapshot,
      'excluded_at',m.excluded_at::text,'profile_image_url',NULL) ORDER BY m.user_id)
      FROM round_members m WHERE m.round_id=r.id) AS members,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e.id,'payer_id',e.payer_id,'amount_minor',e.amount_minor::text,'split_mode',e.split_mode,
      'participant_ids',ARRAY(SELECT s.user_id FROM expense_shares s WHERE s.expense_id=e.id ORDER BY s.user_id),
      'shares',(SELECT jsonb_agg(jsonb_build_object('userId',s.user_id,'assignedAmountMinor',s.assigned_amount_minor::text) ORDER BY s.user_id)
        FROM expense_shares s WHERE s.expense_id=e.id)) ORDER BY e.id) FROM expenses e WHERE e.round_id=r.id),'[]'::jsonb) AS expenses
    FROM rounds r JOIN round_members viewer ON viewer.round_id=r.id AND viewer.user_id=$2 WHERE r.id=$1
), saved AS MATERIALIZED (
  SELECT request_digest,response_metadata FROM mutation_requests WHERE actor_id=$2 AND operation='round.${operation}' AND request_key=$3
), actor AS (
  SELECT EXISTS(SELECT 1 FROM users WHERE id=$2 AND deleted_at IS NULL AND onboarding_completed_at IS NOT NULL) AS active
)`

export function findRoundConfirmation(client: Database, roundId: string, userId: string, key: string, operation: 'confirm' | 'draw' = 'confirm') {
  return client.query<RoundConfirmationRow>(`WITH ${roundSettlementContextSql(operation)}
    SELECT context.*,actor.active AS actor_active,saved.request_digest,saved.response_metadata FROM actor
    LEFT JOIN context ON true LEFT JOIN saved ON true`, [roundId, userId, key])
}

export async function confirmRound(client: Database, roundId: string, userId: string, key: string, digest: string, expectedVersion: number, now: number) {
  return (await client.query<RoundConfirmationRow>(`WITH ${roundSettlementContextSql('confirm')}, confirmed AS (
    UPDATE rounds SET status='CONFIRMED',confirmed_at=$6,version=version+1
    WHERE id=$1 AND creator_id=$2 AND version=$5 AND status='RECORDING' AND completed_at IS NULL
      AND (SELECT active FROM actor) AND NOT EXISTS(SELECT 1 FROM saved)
      AND EXISTS(SELECT 1 FROM context WHERE is_creator AND jsonb_array_length(expenses)>0)
    RETURNING status,version
  ), bases AS (
    UPDATE expenses e SET base_share_minor=trunc(e.amount_minor/(SELECT count(*) FROM expense_shares WHERE expense_id=e.id)),
      remainder_units=mod(e.amount_minor,(SELECT count(*) FROM expense_shares WHERE expense_id=e.id))::int
    WHERE e.round_id=$1 AND e.split_mode<>'CUSTOM' AND EXISTS(SELECT 1 FROM confirmed) RETURNING id
  ), recorded AS (
    INSERT INTO mutation_requests(actor_id,operation,request_key,request_digest,resource_id,response_metadata,created_at)
    SELECT $2,'round.confirm',$3,$4,$1,jsonb_build_object('id',$1::text,'roundId',$1::text,'status',status,'version',version),$6
    FROM confirmed RETURNING request_digest,response_metadata
  ) SELECT context.*,actor.active AS actor_active,COALESCE(recorded.request_digest,saved.request_digest) AS request_digest,
    COALESCE(recorded.response_metadata,saved.response_metadata) AS response_metadata,EXISTS(SELECT 1 FROM confirmed) AS confirmed
    FROM actor LEFT JOIN context ON true LEFT JOIN saved ON true LEFT JOIN recorded ON true`,
  [roundId, userId, key, digest, expectedVersion, now])).rows[0]
}

export async function drawRound(client: Database, roundId: string, userId: string, key: string, digest: string, expectedVersion: number, now: number, result: ReturnType<typeof finalizeSettlement> | null) {
  return (await client.query<RoundRow & { actor_active: boolean; request_digest: string | null; response_metadata: unknown; drawn: boolean }>(`WITH actor AS (
    SELECT EXISTS(SELECT 1 FROM users WHERE id=$2 AND deleted_at IS NULL AND onboarding_completed_at IS NOT NULL) AS active
  ), locked AS MATERIALIZED (
    SELECT r.*,(r.creator_id=$2) AS is_creator FROM rounds r
    JOIN round_members viewer ON viewer.round_id=r.id AND viewer.user_id=$2 WHERE r.id=$1 FOR UPDATE OF r
  ), recorded AS (
    INSERT INTO mutation_requests(actor_id,operation,request_key,request_digest,resource_id,response_metadata,created_at)
    SELECT $2,'round.draw',$3,$4,$1,jsonb_build_object('id',$1::text,'roundId',$1::text,'status',status,
      'version',version+CASE WHEN finalized_at IS NULL THEN 1 ELSE 0 END),$6
    FROM locked WHERE is_creator AND (SELECT active FROM actor)
      AND (finalized_at IS NOT NULL OR (status='LOCKED' AND completed_at IS NULL AND version=$5))
    ON CONFLICT (actor_id,operation,request_key) DO UPDATE SET request_key=EXCLUDED.request_key
    RETURNING request_digest,response_metadata
  ), finalized AS (
    UPDATE rounds r SET finalized_at=$6,version=r.version+1 FROM locked,recorded
    WHERE r.id=locked.id AND locked.finalized_at IS NULL AND locked.status='LOCKED'
      AND locked.completed_at IS NULL AND locked.version=$5 AND recorded.request_digest=$4
    RETURNING r.id
  ), shares AS (
    UPDATE expense_shares s SET final_amount_minor=data.amount_minor,received_remainder=data.received_remainder
    FROM jsonb_to_recordset($7::jsonb) AS data(expense_id text,user_id text,amount_minor numeric,received_remainder boolean)
    WHERE s.round_id=$1 AND s.expense_id=data.expense_id AND s.user_id=data.user_id AND EXISTS(SELECT 1 FROM finalized)
  ), balances AS (
    INSERT INTO settlement_balances(round_id,user_id,paid_minor,burden_minor,balance_minor)
    SELECT $1,data.user_id,data.paid_minor,data.burden_minor,data.balance_minor
    FROM jsonb_to_recordset($8::jsonb) AS data(user_id text,paid_minor numeric,burden_minor numeric,balance_minor numeric)
    WHERE EXISTS(SELECT 1 FROM finalized)
  ), transfers AS (
    INSERT INTO settlement_transfers(round_id,sender_id,receiver_id,amount_minor)
    SELECT $1,data.sender_id,data.receiver_id,data.amount_minor
    FROM jsonb_to_recordset($9::jsonb) AS data(sender_id text,receiver_id text,amount_minor numeric)
    WHERE EXISTS(SELECT 1 FROM finalized)
  ) SELECT locked.*,actor.active AS actor_active,recorded.request_digest,recorded.response_metadata,
    EXISTS(SELECT 1 FROM finalized) AS drawn FROM actor LEFT JOIN locked ON true LEFT JOIN recorded ON true`,
  [roundId, userId, key, digest, expectedVersion, now,
    JSON.stringify(result?.shares.map(s => ({ expense_id: s.expenseId, user_id: s.userId, amount_minor: s.amountMinor, received_remainder: s.receivedRemainder })) ?? []),
    JSON.stringify(result?.balances.map(b => ({ user_id: b.userId, paid_minor: b.paidMinor, burden_minor: b.burdenMinor, balance_minor: b.balanceMinor })) ?? []),
    JSON.stringify(result?.transfers.map(t => ({ sender_id: t.senderId, receiver_id: t.receiverId, amount_minor: t.amountMinor })) ?? [])])).rows[0]
}

export function findRoundReopening(client: Database, roundId: string, userId: string) {
  return client.query<RoundRow & { user_ids: string[] }>(`SELECT r.*,g.name AS group_name,g.creator_id AS group_creator_id,
    (r.creator_id=$2) AS is_creator,ARRAY(SELECT user_id FROM round_members WHERE round_id=r.id) AS user_ids
    FROM rounds r JOIN groups g ON g.id=r.group_id JOIN round_members m ON m.round_id=r.id AND m.user_id=$2
    WHERE r.id=$1`, [roundId, userId])
}

export async function reopenRound(client: Database, roundId: string, userId: string, expectedVersion: number) {
  return (await client.query<MutationResult>(`WITH changed AS (
    UPDATE rounds SET status='RECORDING',confirmed_at=NULL,version=version+1
    WHERE id=$1 AND creator_id=$2 AND status='CONFIRMED' AND completed_at IS NULL AND version=$3
      AND EXISTS(SELECT 1 FROM users WHERE id=$2 AND deleted_at IS NULL AND onboarding_completed_at IS NOT NULL)
    RETURNING id,status,version
  ), cleared AS (
    UPDATE expenses SET base_share_minor=NULL,remainder_units=NULL
    WHERE round_id=$1 AND EXISTS(SELECT 1 FROM changed)
  ) SELECT id,id AS "roundId",status,version FROM changed`, [roundId, userId, expectedVersion])).rows[0]
}

export function lockRound(client: Database, roundId: string, now: number, expectedVersion: number) {
  return client.query("UPDATE rounds SET status='LOCKED',locked_at=$2 WHERE id=$1 AND status='CONFIRMED' AND completed_at IS NULL AND version=$3", [roundId, now, expectedVersion])
}

export function findRemainder(client: Database, roundId: string) {
  return client.query('SELECT 1 FROM expenses WHERE round_id=$1 AND remainder_units>0 LIMIT 1', [roundId])
}

export async function completeCheckedRound(client: Database, roundId: string, userId: string, key: string, digest: string, expectedVersion: number | null, now: number) {
  return (await client.query<RoundCompletionRow>(`WITH actor AS (
    SELECT EXISTS(SELECT 1 FROM users WHERE id=$2 AND deleted_at IS NULL AND onboarding_completed_at IS NOT NULL) AS active
  ), context AS MATERIALIZED (
    SELECT r.*,(r.creator_id=$2) AS is_creator,
      (SELECT count(*)::int FROM settlement_transfers WHERE round_id=r.id AND received_at IS NULL) AS pending_count,
      ARRAY(SELECT user_id FROM round_members WHERE round_id=r.id) AS user_ids
    FROM rounds r JOIN round_members viewer ON viewer.round_id=r.id AND viewer.user_id=$2 WHERE r.id=$1
  ), saved AS (
    SELECT request_digest,response_metadata FROM mutation_requests WHERE actor_id=$2 AND operation='round.complete' AND request_key=$3
  ), completed AS (
    UPDATE rounds SET status='COMPLETED',completed_at=$6,version=version+1
    WHERE id=$1 AND creator_id=$2 AND status='LOCKED' AND completed_at IS NULL AND finalized_at IS NOT NULL AND version=$5::bigint
      AND (SELECT active FROM actor) AND EXISTS(SELECT 1 FROM context) AND NOT EXISTS(SELECT 1 FROM saved)
      AND NOT EXISTS(SELECT 1 FROM settlement_transfers WHERE round_id=$1 AND received_at IS NULL)
    RETURNING id,status,version
  ), recorded AS (
    INSERT INTO mutation_requests(actor_id,operation,request_key,request_digest,resource_id,response_metadata,created_at)
    SELECT $2,'round.complete',$3,$4,id,jsonb_build_object('id',id,'roundId',id,'status',status,'version',version),$6
    FROM completed RETURNING request_digest,response_metadata
  ) SELECT context.*,actor.active AS actor_active,
    COALESCE(recorded.request_digest,saved.request_digest) AS request_digest,
    COALESCE(recorded.response_metadata,saved.response_metadata) AS response_metadata,EXISTS(SELECT 1 FROM completed) AS completed
    FROM actor LEFT JOIN context ON true LEFT JOIN saved ON true LEFT JOIN recorded ON true`, [roundId, userId, key, digest, expectedVersion, now])).rows[0]
}

export function findRoundForceCompletion(client: Database, roundId: string, userId: string, key: string) {
  return client.query<RoundForceCompletionRow>(`SELECT r.*,(r.creator_id=$2) AS is_creator,
    ARRAY(SELECT DISTINCT receiver_id FROM settlement_transfers WHERE round_id=r.id AND received_at IS NULL ORDER BY receiver_id) AS pending_user_ids,
    ARRAY(SELECT user_id FROM round_members WHERE round_id=r.id) AS user_ids,
    saved.request_digest,saved.response_metadata
    FROM (SELECT 1) anchor
    LEFT JOIN rounds r ON r.id=$1 AND EXISTS(SELECT 1 FROM round_members WHERE round_id=r.id AND user_id=$2)
    LEFT JOIN mutation_requests saved ON saved.actor_id=$2 AND saved.operation='round.force-complete' AND saved.request_key=$3`, [roundId, userId, key])
}

export async function forceCompleteRound(client: Database, roundId: string, userId: string, key: string, digest: string, expectedVersion: number, now: number) {
  return (await client.query<RoundRow & { actor_active: boolean; completed: boolean; request_digest: string | null; response_metadata: unknown }>(`WITH actor AS (
    SELECT EXISTS(SELECT 1 FROM users WHERE id=$2 AND deleted_at IS NULL AND onboarding_completed_at IS NOT NULL) AS active
  ), context AS MATERIALIZED (
    SELECT r.*,(r.creator_id=$2) AS is_creator
    FROM rounds r JOIN round_members viewer ON viewer.round_id=r.id AND viewer.user_id=$2 WHERE r.id=$1
  ), saved AS (
    SELECT request_digest,response_metadata FROM mutation_requests WHERE actor_id=$2 AND operation='round.force-complete' AND request_key=$3
  ), completed AS (
    UPDATE rounds SET status='COMPLETED',completed_at=$6,version=version+1
    WHERE id=$1 AND creator_id=$2 AND status='LOCKED' AND completed_at IS NULL AND finalized_at IS NOT NULL AND version=$5
      AND (SELECT active FROM actor) AND EXISTS(SELECT 1 FROM context) AND NOT EXISTS(SELECT 1 FROM saved)
    RETURNING id,status,version
  ), recorded AS (
    INSERT INTO mutation_requests(actor_id,operation,request_key,request_digest,resource_id,response_metadata,created_at)
    SELECT $2,'round.force-complete',$3,$4,id,jsonb_build_object('id',id,'roundId',id,'status',status,'version',version),$6
    FROM completed RETURNING request_digest,response_metadata
  ) SELECT context.*,actor.active AS actor_active,
    COALESCE(recorded.request_digest,saved.request_digest) AS request_digest,
    COALESCE(recorded.response_metadata,saved.response_metadata) AS response_metadata,EXISTS(SELECT 1 FROM completed) AS completed
    FROM actor LEFT JOIN context ON true LEFT JOIN saved ON true LEFT JOIN recorded ON true`, [roundId, userId, key, digest, expectedVersion, now])).rows[0]
}

export function findRoundCancellation(client: Database, roundId: string, userId: string, key: string) {
  return client.query<RoundRow & { has_expenses: boolean; user_ids: string[]; request_digest: string | null; response_metadata: unknown }>(`SELECT r.*,g.name AS group_name,g.creator_id AS group_creator_id,
    (r.creator_id=$2) AS is_creator,
    EXISTS(SELECT 1 FROM expenses WHERE round_id=r.id) AS has_expenses,
    ARRAY(SELECT user_id FROM round_members WHERE round_id=r.id) AS user_ids,
    saved.request_digest,saved.response_metadata
    FROM (SELECT 1) anchor
    LEFT JOIN rounds r ON r.id=$1 AND EXISTS(SELECT 1 FROM round_members WHERE round_id=r.id AND user_id=$2)
    LEFT JOIN groups g ON g.id=r.group_id
    LEFT JOIN mutation_requests saved ON saved.actor_id=$2 AND saved.operation='round.cancel' AND saved.request_key=$3`, [roundId, userId, key])
}

export function deleteRound(client: Database, roundId: string, userId: string, key: string, digest: string, result: unknown, now: number) {
  return client.query(`WITH deleted AS (DELETE FROM rounds WHERE id=$1 RETURNING id)
    INSERT INTO mutation_requests(actor_id,operation,request_key,request_digest,resource_id,response_metadata,created_at)
    SELECT $2,'round.cancel',$3,$4,id,$5,$6 FROM deleted`, [roundId, userId, key, digest, JSON.stringify(result), now])
}

export function findSettlementCheck(client: Database, roundId: string, userId: string) {
  return client.query<SettlementCheckRow>(`SELECT r.*,g.name AS group_name,g.creator_id AS group_creator_id,(r.creator_id=$2) AS is_creator,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('sender_id',t.sender_id,'received_at',t.received_at::text) ORDER BY t.sender_id)
      FROM settlement_transfers t WHERE t.round_id=r.id AND t.receiver_id=$2),'[]'::jsonb) AS incoming,
    ARRAY(SELECT user_id FROM round_members WHERE round_id=r.id) AS user_ids
    FROM rounds r JOIN groups g ON g.id=r.group_id JOIN round_members viewer ON viewer.round_id=r.id AND viewer.user_id=$2
    WHERE r.id=$1`, [roundId, userId])
}

export function setReceived(client: Database, roundId: string, userId: string, senderId: string | null, checked: boolean, now: number, expectedVersion: number) {
  // ponytail: receipt changes and round completion are not serialized; use a shared lock if they must overlap safely.
  return client.query(`UPDATE settlement_transfers SET received_at=CASE
      WHEN $4 THEN $5::bigint ELSE NULL END
      WHERE round_id=$1 AND receiver_id=$2 AND ($3::text IS NULL OR sender_id=$3)
        AND (received_at IS NOT NULL)<>$4
        AND EXISTS(SELECT 1 FROM rounds WHERE id=$1 AND status='LOCKED' AND completed_at IS NULL AND finalized_at IS NOT NULL AND version=$6)
        AND EXISTS(SELECT 1 FROM users WHERE id=$2 AND deleted_at IS NULL AND onboarding_completed_at IS NOT NULL)`,
    [roundId, userId, senderId, checked, now, expectedVersion])
}

export function findSettlement(client: Database, roundId: string, userId: string) {
  return client.query<SettlementRow>(`SELECT r.*,g.name AS group_name,(r.creator_id=$2) AS is_creator,b.balance_minor,
    COALESCE(checks.items,'[]'::jsonb) AS confirmations,
    COALESCE(outgoing.items,'[]'::jsonb) AS outgoing,COALESCE(incoming.items,'[]'::jsonb) AS incoming
    FROM rounds r JOIN groups g ON g.id=r.group_id JOIN round_members viewer ON viewer.round_id=r.id AND viewer.user_id=$2
    LEFT JOIN settlement_balances b ON b.round_id=r.id AND b.user_id=$2 AND r.finalized_at IS NOT NULL
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(to_jsonb(c) ORDER BY c.user_id) AS items FROM (
        SELECT rm.user_id,rm.display_name_snapshot,
          (CASE WHEN bool_and(t.received_at IS NOT NULL) THEN max(t.received_at) ELSE NULL END)::text AS checked_at,
          CASE WHEN u.deleted_at IS NULL THEN u.profile_image_url ELSE NULL END AS profile_image_url
        FROM settlement_transfers t JOIN round_members rm ON rm.round_id=t.round_id AND rm.user_id=t.receiver_id
        JOIN users u ON u.id=rm.user_id WHERE t.round_id=r.id
        GROUP BY rm.user_id,rm.display_name_snapshot,u.deleted_at,u.profile_image_url
      ) c
    ) checks ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('receiver_id',t.receiver_id,'amount_minor',t.amount_minor::text,
        'display_name_snapshot',m.display_name_snapshot,
        'profile_image_url',CASE WHEN u.deleted_at IS NULL THEN u.profile_image_url ELSE NULL END) ||
        CASE WHEN r.currency='KRW' THEN jsonb_build_object('bank_name',u.bank_name,'account_number',u.account_number,
          'account_number_formatted',u.account_number_formatted,'account_holder',u.account_holder,'bank_verified_at',u.bank_verified_at::text)
          ELSE '{}'::jsonb END ORDER BY t.receiver_id) AS items
      FROM settlement_transfers t JOIN round_members m ON m.round_id=t.round_id AND m.user_id=t.receiver_id
      JOIN users u ON u.id=t.receiver_id
      WHERE t.round_id=r.id AND t.sender_id=$2 AND t.received_at IS NULL AND r.finalized_at IS NOT NULL
    ) outgoing ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('sender_id',t.sender_id,'amount_minor',t.amount_minor::text,'received_at',t.received_at::text,
        'display_name_snapshot',m.display_name_snapshot,
        'profile_image_url',CASE WHEN u.deleted_at IS NULL THEN u.profile_image_url ELSE NULL END) ORDER BY t.sender_id) AS items
      FROM settlement_transfers t JOIN round_members m ON m.round_id=t.round_id AND m.user_id=t.sender_id
      JOIN users u ON u.id=t.sender_id WHERE t.round_id=r.id AND t.receiver_id=$2 AND r.finalized_at IS NOT NULL
    ) incoming ON true WHERE r.id=$1`, [roundId, userId])
}

export async function insertReceipt(client: Database, roundId: string, expenseId: string, userId: string, key: string, digest: string, expectedVersion: number, id: string, mimeType: string, byteSize: number, sha256: string, objectKey: string, now: number) {
  return (await client.query<ReceiptCreationRow>(`WITH actor AS (
    SELECT EXISTS(SELECT 1 FROM users WHERE id=$3 AND deleted_at IS NULL AND onboarding_completed_at IS NOT NULL) AS active
  ), context AS MATERIALIZED (
    SELECT r.*,(r.creator_id=$3) AS is_creator,e.id AS expense_id,e.author_id,viewer.excluded_at AS viewer_excluded_at,
      ARRAY(SELECT user_id FROM round_members WHERE round_id=r.id) AS user_ids
    FROM rounds r JOIN round_members viewer ON viewer.round_id=r.id AND viewer.user_id=$3
    LEFT JOIN expenses e ON e.round_id=r.id AND e.id=$2 WHERE r.id=$1
  ), saved AS (
    SELECT request_digest,response_metadata FROM mutation_requests WHERE actor_id=$3 AND operation='receipt.create' AND request_key=$4
  ), changed AS (
    UPDATE rounds r SET version=r.version+1
    WHERE r.id=$1 AND r.status='RECORDING' AND r.completed_at IS NULL AND r.version=$6
      AND (SELECT active FROM actor) AND NOT EXISTS(SELECT 1 FROM saved)
      AND EXISTS(SELECT 1 FROM expenses e JOIN round_members viewer ON viewer.round_id=e.round_id AND viewer.user_id=$3
        WHERE e.id=$2 AND e.round_id=r.id AND (r.creator_id=$3 OR (viewer.excluded_at IS NULL AND e.author_id=$3)))
    RETURNING r.id,r.status,r.version
  ), inserted AS (
    INSERT INTO expense_receipts(id,expense_id,uploaded_by,mime_type,byte_size,sha256,object_key,created_at)
    SELECT $7,$2,$3,$8,$9,$10,$11,$12 FROM changed RETURNING id
  ), recorded AS (
    INSERT INTO mutation_requests(actor_id,operation,request_key,request_digest,resource_id,response_metadata,created_at)
    SELECT $3,'receipt.create',$4,$5,inserted.id,
      jsonb_build_object('id',inserted.id,'roundId',changed.id,'status',changed.status,'version',changed.version),$12
    FROM inserted CROSS JOIN changed RETURNING request_digest,response_metadata
  ) SELECT context.*,actor.active AS actor_active,
    COALESCE(recorded.request_digest,saved.request_digest) AS request_digest,
    COALESCE(recorded.response_metadata,saved.response_metadata) AS response_metadata,EXISTS(SELECT 1 FROM inserted) AS inserted
    FROM actor LEFT JOIN context ON true LEFT JOIN saved ON true LEFT JOIN recorded ON true`,
  [roundId, expenseId, userId, key, digest, expectedVersion, id, mimeType, byteSize, sha256, objectKey, now])).rows[0]
}

const receiptDeletionContextSql = `context AS MATERIALIZED (
  SELECT r.*,(r.creator_id=$4) AS is_creator,e.id AS expense_id,e.author_id,viewer.excluded_at AS viewer_excluded_at,
    rc.id AS receipt_id,ARRAY(SELECT user_id FROM round_members WHERE round_id=r.id ORDER BY user_id) AS user_ids
  FROM rounds r JOIN round_members viewer ON viewer.round_id=r.id AND viewer.user_id=$4
  LEFT JOIN expenses e ON e.round_id=r.id AND e.id=$2
  LEFT JOIN expense_receipts rc ON rc.expense_id=e.id AND rc.id=$3 WHERE r.id=$1
), saved AS MATERIALIZED (
  SELECT request_digest,response_metadata FROM mutation_requests WHERE actor_id=$4 AND operation='receipt.delete' AND request_key=$5
), actor AS (
  SELECT EXISTS(SELECT 1 FROM users WHERE id=$4 AND deleted_at IS NULL AND onboarding_completed_at IS NOT NULL) AS active
)`

export function findReceiptDeletion(client: Database, roundId: string, expenseId: string, receiptId: string, userId: string, key: string) {
  return client.query<ReceiptDeletionRow>(`WITH ${receiptDeletionContextSql}
    SELECT context.*,actor.active AS actor_active,saved.request_digest,saved.response_metadata FROM actor
    LEFT JOIN context ON true LEFT JOIN saved ON true`, [roundId, expenseId, receiptId, userId, key])
}

export async function deleteReceipt(client: Database, roundId: string, expenseId: string, receiptId: string, userId: string, key: string, digest: string, expectedVersion: number, now: number) {
  return (await client.query<ReceiptDeletionRow>(`WITH ${receiptDeletionContextSql}, bumped AS (
    UPDATE rounds r SET version=r.version+1 WHERE r.id=$1 AND r.version=$7 AND r.status='RECORDING' AND r.completed_at IS NULL
      AND (SELECT active FROM actor) AND NOT EXISTS(SELECT 1 FROM saved)
      AND EXISTS(SELECT 1 FROM expenses e JOIN expense_receipts rc ON rc.expense_id=e.id AND rc.id=$3
        JOIN round_members viewer ON viewer.round_id=e.round_id AND viewer.user_id=$4
        WHERE e.round_id=r.id AND e.id=$2 AND (r.creator_id=$4 OR (viewer.excluded_at IS NULL AND e.author_id=$4)))
    RETURNING id,status,version
  ), deleted AS (
    DELETE FROM expense_receipts WHERE id=$3 AND expense_id=$2 AND EXISTS(SELECT 1 FROM bumped) RETURNING id,object_key
  ), recorded AS (
    INSERT INTO mutation_requests(actor_id,operation,request_key,request_digest,resource_id,response_metadata,created_at)
    SELECT $4,'receipt.delete',$5,$6,deleted.id,
      jsonb_build_object('id',deleted.id,'roundId',bumped.id,'status',bumped.status,'version',bumped.version),$8
    FROM deleted CROSS JOIN bumped RETURNING request_digest,response_metadata
  ) SELECT context.*,actor.active AS actor_active,COALESCE(recorded.request_digest,saved.request_digest) AS request_digest,
    COALESCE(recorded.response_metadata,saved.response_metadata) AS response_metadata,
    EXISTS(SELECT 1 FROM deleted) AS deleted,(SELECT object_key FROM deleted) AS object_key
    FROM actor LEFT JOIN context ON true LEFT JOIN saved ON true LEFT JOIN recorded ON true`,
  [roundId, expenseId, receiptId, userId, key, digest, expectedVersion, now])).rows[0]
}

export function findReceipt(client: Database, receiptId: string, userId: string) {
  // Upgraded databases retain BYTEA content; fresh databases have only object_key.
  return client.query<ReceiptContentRow>(`SELECT rc.* FROM expense_receipts rc JOIN expenses e ON e.id=rc.expense_id
    JOIN rounds r ON r.id=e.round_id JOIN round_members viewer ON viewer.round_id=r.id AND viewer.user_id=$2
    WHERE rc.id=$1`, [receiptId, userId])
}
