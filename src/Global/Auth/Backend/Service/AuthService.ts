import 'server-only'
import { createTestOnboardingUser, getTestSignInUser, findOrCreateKakaoUser } from '../../../../Domain/User/Backend'
import { randomUUID } from 'node:crypto'
import {
  ACCESS_TOKEN_MAX_AGE_SECONDS,
  ONBOARDING_MAX_AGE_SECONDS,
  REFRESH_TOKEN_MAX_AGE_SECONDS,
  createAccessToken,
  createRefreshToken,
  currentTimestamp,
  type KakaoProfile,
  type RefreshToken,
} from '../auth-util'
import { withDatabaseConnection, withWriteTransaction } from '../../../../lib/db'
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

// The single statement returns either the existing account state or the new user.
export function signInKakao(providerSubject: string, profile: KakaoProfile) {
  if (!providerSubject) throw new Error('Kakao subject is required')
  return withDatabaseConnection(async (client) => {
    const now = currentTimestamp()
    const user = await findOrCreateKakaoUser(client, providerSubject, profile, now)
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

export function refreshTokens(refresh: RefreshToken) {
  const now = currentTimestamp(), purpose = refresh.purpose ?? 'app'
  const remaining = (refresh.expiresAt ?? now) - now
  const refreshMaxAge = purpose === 'onboarding' ? remaining : REFRESH_TOKEN_MAX_AGE_SECONDS
  const accessMaxAge = Math.min(ACCESS_TOKEN_MAX_AGE_SECONDS, remaining)
  return {
    accessToken: createAccessToken(refresh.userId, refresh.sessionId, undefined, now, accessMaxAge, purpose),
    refreshToken: createRefreshToken(refresh.userId, refresh.sessionId, undefined, now, refreshMaxAge, purpose),
    refreshMaxAge,
  }
}
