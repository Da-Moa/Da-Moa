import 'server-only'
import { createTestOnboardingUser, getTestSignInUser, upsertKakaoUser } from '../../../../Domain/User/Backend'
import { randomUUID } from 'node:crypto'
import {
  ACCESS_TOKEN_MAX_AGE_SECONDS,
  ONBOARDING_MAX_AGE_SECONDS,
  REFRESH_TOKEN_MAX_AGE_SECONDS,
  createAccessToken,
  createRefreshToken,
  currentTimestamp,
  type KakaoProfile,
} from '../../../../lib/auth'
import { withWriteTransaction } from '../../../../lib/db'
import { AppError } from '../../../../lib/errors'
import { TEST_ONBOARDING_KEY, testAccountForKey } from '../../../../lib/test-accounts'

export type AuthSession = {
  userId: string
  purpose: 'app' | 'onboarding'
  accessToken: string
  refreshToken: string
  accessMaxAge: number
  refreshMaxAge: number
}

export function issueTokens(userId: string, purpose: 'app' | 'onboarding', now: number): AuthSession {
  const sessionId = randomUUID()
  const accessMaxAge = purpose === 'onboarding' ? ONBOARDING_MAX_AGE_SECONDS : ACCESS_TOKEN_MAX_AGE_SECONDS
  const refreshMaxAge = purpose === 'onboarding' ? ONBOARDING_MAX_AGE_SECONDS : REFRESH_TOKEN_MAX_AGE_SECONDS
  const refreshToken = createRefreshToken(userId, sessionId, undefined, now, refreshMaxAge, purpose)
  const accessToken = createAccessToken(userId, sessionId, undefined, now, accessMaxAge, purpose)
  return { userId, purpose, accessToken, refreshToken, accessMaxAge, refreshMaxAge }
}

// Decide the signed JWT purpose from the user state under the same write lock.
export function signInKakao(providerSubject: string, profile: KakaoProfile) {
  if (!providerSubject) throw new Error('Kakao subject is required')
  return withWriteTransaction(async (client) => {
    const now = currentTimestamp()
    const user = await upsertKakaoUser(client, providerSubject, profile, now)
    const purpose = user.deletedAt !== null || user.onboardingCompletedAt === null ? 'onboarding' : 'app'
    return issueTokens(user.id, purpose, now)
  })
}

export function signInTestAccount(key: unknown) {
  const fixture = testAccountForKey(key)
  if (process.env.NODE_ENV === 'production' || !fixture && key !== TEST_ONBOARDING_KEY) {
    throw new AppError(404, 'not_found', '테스트 계정을 찾을 수 없습니다')
  }
  return withWriteTransaction(async (client) => {
    if (!fixture) {
      const id = randomUUID(), now = currentTimestamp()
      await createTestOnboardingUser(client, id, now)
      return issueTokens(id, 'onboarding', now)
    }
    const userId = await getTestSignInUser(client, fixture.id, fixture.providerSubject)
    if (!userId) throw new AppError(404, 'not_found', '테스트 계정을 먼저 시드해 주세요')
    return issueTokens(userId, 'app', currentTimestamp())
  })
}
