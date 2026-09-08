import { randomUUID } from 'node:crypto'
import {
  ACCESS_TOKEN_MAX_AGE_SECONDS,
  ONBOARDING_MAX_AGE_SECONDS,
  REFRESH_TOKEN_MAX_AGE_SECONDS,
  createAccessToken,
  createRefreshToken,
  currentTimestamp,
  hashRefreshToken,
  type AccessToken,
  type KakaoProfile,
} from './auth'
import { requireAccount, type Account } from './authorization'
import { withWriteTransaction, type Database } from './db'
import { AppError } from './errors'
import { objectBody, replayMutation, saveMutation } from './mutations'
import { testAccountForKey } from './test-accounts'

export type UserAccount = Pick<Account, 'displayName' | 'email' | 'profileImageUrl'>
export type BankAccount = { bankName: string; accountNumber: string; accountHolder: string }
export type AuthSession = {
  userId: string
  purpose: 'app' | 'onboarding'
  accessToken: string
  refreshToken: string
  accessMaxAge: number
  refreshMaxAge: number
}

type RefreshSessionInput = {
  expiresAt: number
  id: string
  issuedAt: number
  tokenHash: string
  userId: string
}
type RefreshSessionRotationInput = RefreshSessionInput & {
  now: number
  previousSessionId: string
  previousTokenHash: string
}

export function parseBankAccount(value: unknown): BankAccount {
  const body = objectBody(value)
  const text = (field: string) => {
    const value = body[field]
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 100 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new AppError(400, 'invalid_bank_account', '은행명과 예금주를 1~100자로 입력해 주세요')
    }
    return value.trim()
  }
  const bankName = text('bankName')
  const accountHolder = text('accountHolder')
  const raw = body.accountNumber
  if (typeof raw !== 'string' || !raw || raw.length > 100 || /[^0-9 -]/.test(raw)) {
    throw new AppError(400, 'invalid_bank_account', '계좌번호는 숫자, 공백, 하이픈으로 입력해 주세요')
  }
  const accountNumber = raw.replace(/[ -]/g, '')
  if (!/^[0-9]{1,64}$/.test(accountNumber)) {
    throw new AppError(400, 'invalid_bank_account', '계좌번호는 숫자 1~64자리로 입력해 주세요')
  }
  return { bankName, accountNumber, accountHolder }
}

async function issueSession(client: Database, userId: string, purpose: 'app' | 'onboarding', now: number): Promise<AuthSession> {
  const sessionId = randomUUID()
  const accessMaxAge = purpose === 'onboarding' ? ONBOARDING_MAX_AGE_SECONDS : ACCESS_TOKEN_MAX_AGE_SECONDS
  const refreshMaxAge = purpose === 'onboarding' ? ONBOARDING_MAX_AGE_SECONDS : REFRESH_TOKEN_MAX_AGE_SECONDS
  const refreshToken = createRefreshToken(userId, sessionId, undefined, now, refreshMaxAge)
  const accessToken = createAccessToken(userId, sessionId, undefined, now, accessMaxAge)
  await client.query(`
    INSERT INTO refresh_sessions(id, user_id, token_hash, issued_at, expires_at, purpose)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [sessionId, userId, hashRefreshToken(refreshToken), now, now + refreshMaxAge, purpose])
  return { userId, purpose, accessToken, refreshToken, accessMaxAge, refreshMaxAge }
}

// User identity and the allowed session purpose are decided under the same write lock.
// A concurrent withdrawal cannot leave an app session attached to a deleted account.
export function signInKakao(providerSubject: string, profile: KakaoProfile) {
  if (!providerSubject) throw new Error('Kakao subject is required')
  return withWriteTransaction(async (client) => {
    const now = currentTimestamp()
    const { rows } = await client.query(`
      INSERT INTO users(id, provider, provider_subject, display_name, email, profile_image_url, created_at, updated_at)
      VALUES ($1, 'kakao', $2, $3, $4, $5, $6, $6)
      ON CONFLICT (provider, provider_subject) DO UPDATE SET
        display_name = COALESCE(EXCLUDED.display_name, users.display_name),
        email = COALESCE(EXCLUDED.email, users.email),
        profile_image_url = COALESCE(EXCLUDED.profile_image_url, users.profile_image_url),
        updated_at = EXCLUDED.updated_at
      RETURNING id, deleted_at, onboarding_completed_at
    `, [randomUUID(), providerSubject, profile.displayName, profile.email, profile.profileImageUrl, now])
    const user = rows[0]
    const purpose = user.deleted_at !== null || user.onboarding_completed_at === null ? 'onboarding' : 'app'
    return issueSession(client, user.id, purpose, now)
  })
}

export function signInTestAccount(key: unknown) {
  const fixture = testAccountForKey(key)
  if (process.env.NODE_ENV === 'production' || !fixture) {
    throw new AppError(404, 'not_found', '테스트 계정을 찾을 수 없습니다')
  }
  return withWriteTransaction(async (client) => {
    const { rows } = await client.query(`
      SELECT id FROM users
      WHERE id = $1 AND provider = 'test' AND provider_subject = $2
        AND deleted_at IS NULL AND onboarding_completed_at IS NOT NULL
        AND bank_name IS NOT NULL AND account_number IS NOT NULL AND account_holder IS NOT NULL
    `, [fixture.id, fixture.providerSubject])
    if (!rows.length) throw new AppError(404, 'not_found', '테스트 계정을 먼저 시드해 주세요')
    return issueSession(client, fixture.id, 'app', currentTimestamp())
  })
}

export function completeOnboarding(access: AccessToken | null, input: unknown) {
  const bank = parseBankAccount(input)
  const body = objectBody(input)
  return withWriteTransaction(async (client) => {
    const account = await requireAccount(client, access, true)
    if (account.purpose !== 'onboarding') throw new AppError(409, 'already_onboarded', '이미 가입을 완료했습니다')
    if (account.deletedAt !== null && body.confirmRejoin !== true) {
      throw new AppError(400, 'rejoin_confirmation_required', '이전 기록을 유지하여 재가입하는 데 동의해 주세요')
    }
    const now = currentTimestamp()
    await client.query(`
      UPDATE users SET bank_name = $2, account_number = $3, account_holder = $4,
        bank_updated_at = $5, deleted_at = NULL, onboarding_completed_at = $5, updated_at = $5
      WHERE id = $1
    `, [account.id, bank.bankName, bank.accountNumber, bank.accountHolder, now])
    await client.query('UPDATE refresh_sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL', [account.id, now])
    // Memberships deliberately stay inactive after rejoining.
    return issueSession(client, account.id, 'app', now)
  })
}

export function updateBankAccount(access: AccessToken | null, requestKey: string, input: unknown) {
  const bank = parseBankAccount(input)
  return withWriteTransaction(async (client) => {
    const account = await requireAccount(client, access)
    const operation = 'bank-account.update'
    const prior = await replayMutation<{ id: string }>(client, account.id, operation, requestKey, bank)
    if (prior.result) return prior.result
    const now = currentTimestamp()
    await client.query(`UPDATE users SET bank_name = $2, account_number = $3, account_holder = $4,
      bank_updated_at = $5, updated_at = $5 WHERE id = $1`, [account.id, bank.bankName, bank.accountNumber, bank.accountHolder, now])
    const result = { id: account.id }
    await saveMutation(client, account.id, operation, requestKey, prior.digest, account.id, result)
    return result
  })
}

export function withdrawAccount(access: AccessToken | null) {
  return withWriteTransaction(async (client) => {
    const account = await requireAccount(client, access)
    const { rows } = await client.query(`
      SELECT r.id, r.name, r.status, g.id AS "groupId", g.name AS "groupName"
      FROM round_members rm JOIN rounds r ON r.id = rm.round_id JOIN groups g ON g.id = r.group_id
      WHERE rm.user_id = $1 AND r.status <> 'COMPLETED'
      ORDER BY r.created_at, r.id
    `, [account.id])
    if (rows.length) throw new AppError(409, 'unfinished_rounds', '진행 중인 정산이 있어 탈퇴할 수 없습니다', { rounds: rows })
    const now = currentTimestamp()
    await client.query('UPDATE users SET deleted_at = $2, updated_at = $2 WHERE id = $1', [account.id, now])
    await client.query('UPDATE refresh_sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL', [account.id, now])
    await client.query('UPDATE group_members SET left_at = $2 WHERE user_id = $1 AND left_at IS NULL', [account.id, now])
    return { ok: true }
  })
}

export async function rotateRefreshSession(input: RefreshSessionRotationInput) {
  const { expiresAt, id, issuedAt, now, previousSessionId, previousTokenHash, tokenHash, userId } = input
  if (expiresAt <= issuedAt) throw new Error('Refresh session must expire after it is issued')
  if (!id || !userId || !tokenHash || !previousSessionId || !previousTokenHash) throw new Error('Refresh session is required')
  if (id === previousSessionId || tokenHash === previousTokenHash) throw new Error('Refresh session rotation requires a new token')
  return withWriteTransaction(async (client) => {
    const { rows } = await client.query(`
      WITH revoked AS (
        UPDATE refresh_sessions s SET revoked_at = $1
        FROM users u
        WHERE s.id = $2 AND s.user_id = $3 AND s.token_hash = $4
          AND s.revoked_at IS NULL AND s.expires_at > $1 AND s.purpose = 'app'
          AND u.id = s.user_id AND u.deleted_at IS NULL AND u.onboarding_completed_at IS NOT NULL
        RETURNING s.id
      )
      INSERT INTO refresh_sessions(id, user_id, token_hash, issued_at, expires_at, purpose)
      SELECT $5, $3, $6, $7, $8, 'app' WHERE EXISTS (SELECT 1 FROM revoked)
      RETURNING id
    `, [now, previousSessionId, userId, previousTokenHash, id, tokenHash, issuedAt, expiresAt])
    return rows.length > 0
  })
}

export async function deleteRefreshSession(userId: string, sessionId: string) {
  if (!userId || !sessionId) throw new Error('Refresh session is required')
  return withWriteTransaction(async (client) => {
    await client.query(`UPDATE refresh_sessions SET revoked_at = $3
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`, [sessionId, userId, currentTimestamp()])
  })
}
