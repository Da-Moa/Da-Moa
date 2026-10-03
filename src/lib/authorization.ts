import 'server-only'
import { getUserAccountState } from '../Domain/User/Backend'
import type { UserAccountState } from '../Domain/User/Shared'
import type { AccessToken } from './auth'
import { withReadTransaction, type Database } from './db'
import { AppError } from './errors'

export type Account = UserAccountState & { purpose: 'app' | 'onboarding' }

export async function requireAccount(client: Database, access: AccessToken | null, allowOnboarding = false): Promise<Account> {
  if (!access) throw new AppError(401, 'unauthorized', '로그인이 필요합니다')
  const purpose = access.purpose ?? 'app'
  const row = await getUserAccountState(client, access.userId)
  if (!row || (purpose === 'app' && row.deletedAt !== null)
    || (purpose === 'onboarding' && row.deletedAt === null && row.onboardingCompletedAt !== null)) {
    throw new AppError(401, 'unauthorized', '로그인이 필요합니다')
  }
  if (!allowOnboarding && (purpose !== 'app' || row.onboardingCompletedAt === null)) {
    throw new AppError(403, 'onboarding_required', '계좌 등록과 가입 완료가 필요합니다')
  }
  return { ...row, purpose }
}

export async function getAccount(access: AccessToken | null, allowOnboarding = false) {
  if (!access) throw new AppError(401, 'unauthorized', '로그인이 필요합니다')
  return withReadTransaction((client) => requireAccount(client, access, allowOnboarding))
}
