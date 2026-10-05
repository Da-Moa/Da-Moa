import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Database } from '../../../../Global/Util/Backend'
import type { KakaoProfile } from '../../../../Global/Auth/Backend'
import type { BankAccountInput } from '../../Shared'
import type { SignInUserRow, UserRow } from '../DAO/UserDAO'
import { endUserMembershipsSql } from '../../../Group/Backend'
import { unfinishedUserRoundsSql } from '../../../Settle/Backend'
import type { UnfinishedUserRound } from '../../../Settle/Shared'

export async function findUser(client: Database, userId: string): Promise<UserRow | undefined> {
  const { rows } = await client.query<UserRow>(`
    SELECT u.id, u.display_name, u.email, u.profile_image_url,
           u.bank_name, u.account_number, u.account_number_formatted, u.account_holder, u.bank_code, u.bank_verified_at, u.bank_version,
           u.deleted_at, u.onboarding_completed_at, u.updated_at
    FROM users u WHERE u.id = $1
  `, [userId])
  return rows[0]
}

export async function findOrCreateKakaoUser(client: Database, providerSubject: string, profile: KakaoProfile, now: number): Promise<SignInUserRow | undefined> {
  const { rows } = await client.query<SignInUserRow>(`
    WITH existing AS MATERIALIZED (
      SELECT id, deleted_at, onboarding_completed_at
      FROM users WHERE provider = 'kakao' AND provider_subject = $2
    ), inserted AS (
      INSERT INTO users(id, provider, provider_subject, display_name, email, profile_image_url, created_at, updated_at)
      SELECT $1, 'kakao', $2, $3, $4, $5, $6, $6
      WHERE NOT EXISTS (SELECT 1 FROM existing)
      ON CONFLICT (provider, provider_subject) DO NOTHING
      RETURNING id, deleted_at, onboarding_completed_at
    )
    SELECT id, deleted_at, onboarding_completed_at FROM existing
    UNION ALL
    SELECT id, deleted_at, onboarding_completed_at FROM inserted
    `, [randomUUID(), providerSubject, profile.displayName, profile.email, profile.profileImageUrl, now])
  return rows[0]
}

export async function insertTestOnboardingUser(client: Database, id: string, now: number) {
  await client.query(`
        INSERT INTO users(id, provider, provider_subject, display_name, created_at, updated_at)
        VALUES ($1, 'test', $2, '민지', $3, $3)
      `, [id, `da-moa:test-only:onboarding:${id}`, now])
}

export async function findTestSignInUser(client: Database, id: string, providerSubject: string): Promise<string | undefined> {
  const { rows } = await client.query(`
      SELECT id FROM users
      WHERE id = $1 AND provider = 'test' AND provider_subject = $2
        AND deleted_at IS NULL AND onboarding_completed_at IS NOT NULL
        AND bank_name IS NOT NULL AND account_number IS NOT NULL AND account_holder IS NOT NULL
    `, [id, providerSubject])
  return rows[0]?.id
}

export async function saveOnboarding(client: Database, userId: string, bank: BankAccountInput, now: number, expectedUpdatedAt: number) {
  const { rowCount } = await client.query(`
      UPDATE users SET bank_name = $2, account_number = $3, account_holder = $4,
        bank_updated_at = $5, deleted_at = NULL, onboarding_completed_at = $5, updated_at = $5,
        bank_code = $6, account_number_formatted = $7,
        bank_verified_at = NULL, bank_verification_tran_id = NULL, bank_version = bank_version + 1
      WHERE id = $1 AND updated_at = $8 AND bank_version = $9
        AND (deleted_at IS NOT NULL OR onboarding_completed_at IS NULL)
    `, [userId, bank.bankName, bank.accountNumber, bank.accountHolder, now, bank.bankCode, bank.formattedAccountNumber,
      expectedUpdatedAt, bank.expectedBankVersion])
  return rowCount === 1
}

export async function saveBankAccount(client: Database, userId: string, bank: BankAccountInput, now: number) {
  const { rowCount } = await client.query(`UPDATE users SET bank_name = $2, account_number = $3, account_holder = $4,
      bank_updated_at = $5, updated_at = $5, bank_code = $6, account_number_formatted = $7,
      bank_verified_at = CASE WHEN bank_code=$6 AND account_number=$3 AND account_holder=$4 THEN bank_verified_at ELSE NULL END,
      bank_verification_tran_id = CASE WHEN bank_code=$6 AND account_number=$3 AND account_holder=$4 THEN bank_verification_tran_id ELSE NULL END,
      bank_version = bank_version + 1 WHERE id = $1 AND bank_version = $8
        AND deleted_at IS NULL AND onboarding_completed_at IS NOT NULL`,
    [userId, bank.bankName, bank.accountNumber, bank.accountHolder, now, bank.bankCode, bank.formattedAccountNumber, bank.expectedBankVersion])
  return rowCount === 1
}

export async function softDeleteUser(client: Database, userId: string, now: number) {
  const { rows } = await client.query<{ deleted: boolean; unfinishedRounds: UnfinishedUserRound[]; groupIds: string[] }>(`
    WITH unfinished AS MATERIALIZED (${unfinishedUserRoundsSql}), withdrawn AS (
      UPDATE users SET deleted_at = $2, updated_at = $2
      WHERE id = $1 AND deleted_at IS NULL AND onboarding_completed_at IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM unfinished)
      RETURNING id
    ), departed AS (${endUserMembershipsSql})
    SELECT EXISTS(SELECT 1 FROM withdrawn) AS deleted,
      COALESCE((SELECT jsonb_agg(unfinished) FROM unfinished), '[]'::jsonb) AS "unfinishedRounds",
      ARRAY(SELECT group_id FROM departed) AS "groupIds"
  `, [userId, now])
  return rows[0]
}
