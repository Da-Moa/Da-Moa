import type { AccessToken } from './auth'
import { withReadTransaction, type Database } from './db'
import { AppError } from './errors'

export type Account = {
  id: string
  displayName: string | null
  email: string | null
  profileImageUrl: string | null
  bankName: string | null
  accountNumber: string | null
  formattedAccountNumber: string | null
  accountHolder: string | null
  bankCode: string | null
  bankVerifiedAt: number | null
  bankVersion: number
  deletedAt: number | null
  onboardingCompletedAt: number | null
  purpose: 'app' | 'onboarding'
}

export async function requireAccount(client: Database, access: AccessToken | null, allowOnboarding = false): Promise<Account> {
  if (!access) throw new AppError(401, 'unauthorized', '로그인이 필요합니다')
  const purpose = access.purpose ?? 'app'
  const { rows } = await client.query(`
    SELECT u.id, u.display_name, u.email, u.profile_image_url,
           u.bank_name, u.account_number, u.account_number_formatted, u.account_holder, u.bank_code, u.bank_verified_at, u.bank_version,
           u.deleted_at, u.onboarding_completed_at
    FROM users u WHERE u.id = $1
  `, [access.userId])
  const row = rows[0]
  if (!row || (purpose === 'app' && row.deleted_at !== null)
    || (purpose === 'onboarding' && row.deleted_at === null && row.onboarding_completed_at !== null)) {
    throw new AppError(401, 'unauthorized', '로그인이 필요합니다')
  }
  if (!allowOnboarding && (purpose !== 'app' || row.onboarding_completed_at === null)) {
    throw new AppError(403, 'onboarding_required', '계좌 등록과 가입 완료가 필요합니다')
  }
  return {
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    profileImageUrl: row.profile_image_url,
    bankName: row.bank_name,
    accountNumber: row.account_number,
    formattedAccountNumber: row.account_number_formatted,
    accountHolder: row.account_holder,
    bankCode: row.bank_code,
    bankVerifiedAt: row.bank_verified_at === null ? null : Number(row.bank_verified_at),
    bankVersion: Number(row.bank_version),
    deletedAt: row.deleted_at === null ? null : Number(row.deleted_at),
    onboardingCompletedAt: row.onboarding_completed_at === null ? null : Number(row.onboarding_completed_at),
    purpose,
  }
}

export async function getAccount(access: AccessToken | null, allowOnboarding = false) {
  if (!access) throw new AppError(401, 'unauthorized', '로그인이 필요합니다')
  return withReadTransaction((client) => requireAccount(client, access, allowOnboarding))
}
