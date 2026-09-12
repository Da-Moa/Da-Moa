import { authCookieOptions, currentTimestamp, type AccessToken } from './auth'
import { decryptOpenBankingSecret, encryptOpenBankingSecret } from './openbanking'

export const OPENBANKING_CALLBACK_COOKIE = 'da_moa_openbanking_callback'
export const OPENBANKING_CALLBACK_MAX_AGE = 600
export const openBankingCallbackCookieOptions = (maxAge = OPENBANKING_CALLBACK_MAX_AGE) => authCookieOptions(maxAge, '/auth/v1/openbanking')
const validState = (state: string) => /^[A-Za-z0-9_-]{32}$/.test(state)
const validId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)

export function createOpenBankingCallbackCookie(access: AccessToken, state: string, now = currentTimestamp()): string {
  if (!validState(state) || !validId(access.userId) || !validId(access.sessionId) || !Number.isSafeInteger(access.issuedAt) || access.issuedAt < 0 || access.issuedAt > now) throw new Error('Invalid OAuth callback session')
  return encryptOpenBankingSecret(JSON.stringify({ userId: access.userId, sessionId: access.sessionId, issuedAt: access.issuedAt, expiresAt: now + OPENBANKING_CALLBACK_MAX_AGE }), `oauth-session:${state}`)
}

// This proof is only accepted by the OAuth callback; the original state and DB session still authorize it.
// It never issues an app token or rotates a session when the five-minute access cookie has expired.
export function readOpenBankingCallbackCookie(cookie: string | undefined, state: string, now = currentTimestamp()): AccessToken | null {
  if (!cookie || cookie.length > 2048 || !validState(state)) return null
  try {
    const payload = JSON.parse(decryptOpenBankingSecret(cookie, `oauth-session:${state}`)) as Record<string, unknown>
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).sort().join(',') !== 'expiresAt,issuedAt,sessionId,userId'
      || !validId(payload.userId) || !validId(payload.sessionId)
      || typeof payload.issuedAt !== 'number' || !Number.isSafeInteger(payload.issuedAt) || payload.issuedAt < 0 || payload.issuedAt > now
      || typeof payload.expiresAt !== 'number' || !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= now || payload.expiresAt > now + OPENBANKING_CALLBACK_MAX_AGE) return null
    return { userId: payload.userId, sessionId: payload.sessionId, issuedAt: payload.issuedAt }
  } catch { return null }
}
