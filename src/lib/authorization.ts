import type { AccessToken } from './auth'
import { currentTimestamp } from './auth'
import { withReadTransaction, type Database } from './db'
import { AppError } from './errors'

export type Account = {
  id: string
  displayName: string | null
  email: string | null
  profileImageUrl: string | null
  bankName: string | null
  accountNumber: string | null
  accountHolder: string | null
  deletedAt: number | null
  onboardingCompletedAt: number | null
  purpose: 'app' | 'onboarding'
}

export async function requireAccount(client: Database, access: AccessToken | null, allowOnboarding = false): Promise<Account> {
  if (!access) throw new AppError(401, 'unauthorized', '로그인이 필요합니다')
  const { rows } = await client.query(`
    SELECT u.id, u.display_name, u.email, u.profile_image_url,
           u.bank_name, u.account_number, u.account_holder,
           u.deleted_at, u.onboarding_completed_at, s.purpose
    FROM refresh_sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL AND s.expires_at > $3
  `, [access.sessionId, access.userId, currentTimestamp()])
  const row = rows[0]
  if (!row || (row.purpose === 'app' && row.deleted_at !== null)) {
    throw new AppError(401, 'unauthorized', '로그인이 필요합니다')
  }
  if (!allowOnboarding && (row.purpose !== 'app' || row.onboarding_completed_at === null)) {
    throw new AppError(403, 'onboarding_required', '계좌 등록과 가입 완료가 필요합니다')
  }
  return {
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    profileImageUrl: row.profile_image_url,
    bankName: row.bank_name,
    accountNumber: row.account_number,
    accountHolder: row.account_holder,
    deletedAt: row.deleted_at === null ? null : Number(row.deleted_at),
    onboardingCompletedAt: row.onboarding_completed_at === null ? null : Number(row.onboarding_completed_at),
    purpose: row.purpose,
  }
}

export async function getAccount(access: AccessToken | null, allowOnboarding = false) {
  if (!access) throw new AppError(401, 'unauthorized', '로그인이 필요합니다')
  return withReadTransaction((client) => requireAccount(client, access, allowOnboarding))
}
