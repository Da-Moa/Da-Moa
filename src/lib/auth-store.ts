import { createHmac, randomUUID } from 'node:crypto'
import {
  ACCESS_TOKEN_MAX_AGE_SECONDS,
  ONBOARDING_MAX_AGE_SECONDS,
  REFRESH_TOKEN_MAX_AGE_SECONDS,
  createAccessToken,
  createRefreshToken,
  currentTimestamp,
  type AccessToken,
  type KakaoProfile,
} from './auth'
import { requireAccount, type Account } from './authorization'
import { withWriteTransaction } from './db'
import { AppError } from './errors'
import { objectBody, replayMutation, saveMutation } from './mutations'
import { TEST_ONBOARDING_KEY, testAccountForKey } from './test-accounts'
import { normalizeBankAccountInput, type BankAccountInput } from './bank-account'

export type UserAccount = Pick<Account, 'displayName' | 'email' | 'profileImageUrl'>
export type AuthSession = {
  userId: string
  purpose: 'app' | 'onboarding'
  accessToken: string
  refreshToken: string
  accessMaxAge: number
  refreshMaxAge: number
}

function issueTokens(userId: string, purpose: 'app' | 'onboarding', now: number): AuthSession {
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
      await client.query(`
        INSERT INTO users(id, provider, provider_subject, display_name, created_at, updated_at)
        VALUES ($1, 'test', $2, '민지', $3, $3)
      `, [id, `da-moa:test-only:onboarding:${id}`, now])
      return issueTokens(id, 'onboarding', now)
    }
    const { rows } = await client.query(`
      SELECT id FROM users
      WHERE id = $1 AND provider = 'test' AND provider_subject = $2
        AND deleted_at IS NULL AND onboarding_completed_at IS NOT NULL
        AND bank_name IS NOT NULL AND account_number IS NOT NULL AND account_holder IS NOT NULL
    `, [fixture.id, fixture.providerSubject])
    if (!rows.length) throw new AppError(404, 'not_found', '테스트 계정을 먼저 시드해 주세요')
    return issueTokens(fixture.id, 'app', currentTimestamp())
  })
}

function assertBankVersion(account: Account, expectedVersion: number) {
  if (account.bankVersion !== expectedVersion) throw new AppError(409, 'bank_account_conflict', '계좌가 변경됐어요. 최신 계좌를 확인하고 다시 입력해 주세요')
}

function assertOnboarding(account: Account, bank: BankAccountInput) {
  if (account.purpose !== 'onboarding') throw new AppError(409, 'already_onboarded', '이미 가입을 완료했습니다')
  if (account.deletedAt !== null && !bank.confirmRejoin) throw new AppError(400, 'rejoin_confirmation_required', '이전 기록을 유지하여 재가입하는 데 동의해 주세요')
  assertBankVersion(account, bank.expectedBankVersion)
}

export async function completeOnboarding(access: AccessToken | null, input: unknown) {
  const bank = normalizeBankAccountInput(objectBody(input), { onboarding: true })
  return withWriteTransaction(async (client) => {
    const account = await requireAccount(client, access, true)
    assertOnboarding(account, bank)
    const now = currentTimestamp()
    await client.query(`
      UPDATE users SET bank_name = $2, account_number = $3, account_holder = $4,
        bank_updated_at = $5, deleted_at = NULL, onboarding_completed_at = $5, updated_at = $5,
        bank_code = $6, account_number_formatted = $7,
        bank_verified_at = NULL, bank_verification_tran_id = NULL, bank_version = bank_version + 1
      WHERE id = $1
    `, [account.id, bank.bankName, bank.accountNumber, bank.accountHolder, now, bank.bankCode, bank.formattedAccountNumber])
    // Memberships deliberately stay inactive after rejoining.
    return issueTokens(account.id, 'app', now)
  })
}

export async function updateBankAccount(access: AccessToken | null, requestKey: string, input: unknown) {
  const bank = normalizeBankAccountInput(objectBody(input))
  const operation = 'bank-account.update'
  const initial = await withWriteTransaction(async client => {
    const account = await requireAccount(client, access)
    const secret = process.env.AUTH_JWT_SECRET
    if (!secret || Buffer.byteLength(secret) < 32) throw new Error('AUTH_JWT_SECRET must be at least 32 bytes')
    const fingerprint = createHmac('sha256', secret).update(JSON.stringify(['PUT /api/me/bank-account', account.id,
      bank.bankCode, bank.accountNumber, '', bank.accountHolder, bank.expectedBankVersion, false])).digest('hex')
    const prior = await replayMutation<{ id: string; bankVersion: number }>(client, account.id, operation, requestKey, fingerprint)
    return { ...prior, fingerprint }
  })
  if (initial.result) return initial.result
  return withWriteTransaction(async client => {
    // Replay precedes the version assertion: a concurrent copy may already have committed this exact request.
    const current = await requireAccount(client, access)
    const prior = await replayMutation<{ id: string; bankVersion: number }>(client, current.id, operation, requestKey, initial.fingerprint)
    if (prior.result) return prior.result
    assertBankVersion(current, bank.expectedBankVersion)
    const now = currentTimestamp()
    await client.query(`UPDATE users SET bank_name = $2, account_number = $3, account_holder = $4,
      bank_updated_at = $5, updated_at = $5, bank_code = $6, account_number_formatted = $7,
      bank_verified_at = CASE WHEN bank_code=$6 AND account_number=$3 AND account_holder=$4 THEN bank_verified_at ELSE NULL END,
      bank_verification_tran_id = CASE WHEN bank_code=$6 AND account_number=$3 AND account_holder=$4 THEN bank_verification_tran_id ELSE NULL END,
      bank_version = bank_version + 1 WHERE id = $1`,
    [current.id, bank.bankName, bank.accountNumber, bank.accountHolder, now, bank.bankCode, bank.formattedAccountNumber])
    const result = { id: current.id, bankVersion: bank.expectedBankVersion + 1 }
    await saveMutation(client, current.id, operation, requestKey, prior.digest, current.id, result)
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
    const { rows: memberships } = await client.query('SELECT group_id FROM group_members WHERE user_id=$1 AND left_at IS NULL', [account.id])
    const now = currentTimestamp()
    await client.query('UPDATE users SET deleted_at = $2, updated_at = $2 WHERE id = $1', [account.id, now])
    await client.query('UPDATE group_members SET left_at = $2 WHERE user_id = $1 AND left_at IS NULL', [account.id, now])
    return { ok: true, userId: account.id, groupIds: memberships.map(row => String(row.group_id)) }
  })
}
