import { neon } from '@neondatabase/serverless'
import type { NeonQueryFunction } from '@neondatabase/serverless'
import { randomUUID } from 'node:crypto'

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

type KakaoProfileInput = {
  displayName: string | null
  email: string | null
  profileImageUrl: string | null
}

export type UserAccount = KakaoProfileInput

let sql: NeonQueryFunction<false, false> | undefined

function getSql() {
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL
  if (!connectionString) throw new Error('DATABASE_URL is required')
  return sql ??= neon(connectionString)
}

export async function upsertKakaoUser(providerSubject: string, profile: KakaoProfileInput, now: number) {
  if (!providerSubject) throw new Error('Kakao subject is required')

  const rows = await getSql().query(`
    INSERT INTO users (
      id, provider, provider_subject, display_name, email, profile_image_url, created_at, updated_at
    )
    VALUES ($1, 'kakao', $2, $3, $4, $5, $6, $6)
    ON CONFLICT (provider, provider_subject) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      email = EXCLUDED.email,
      profile_image_url = EXCLUDED.profile_image_url,
      updated_at = EXCLUDED.updated_at
    RETURNING id
  `, [
    randomUUID(),
    providerSubject,
    profile.displayName,
    profile.email,
    profile.profileImageUrl,
    now,
  ]) as Array<{ id?: unknown }>
  const user = rows[0]
  if (!user || typeof user.id !== 'string') throw new Error('Could not save Kakao user')

  return { id: user.id }
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export async function getUserAccount(userId: string): Promise<UserAccount | null> {
  const rows = await getSql().query(`
    SELECT display_name, email, profile_image_url
    FROM users
    WHERE id = $1
    LIMIT 1
  `, [userId]) as Array<{
    display_name?: unknown
    email?: unknown
    profile_image_url?: unknown
  }>
  const user = rows[0]
  if (!user) return null

  return {
    displayName: nullableText(user.display_name),
    email: nullableText(user.email),
    profileImageUrl: nullableText(user.profile_image_url),
  }
}

export async function deleteUser(userId: string) {
  if (!userId) throw new Error('User ID is required')

  const rows = await getSql().query(`
    DELETE FROM users
    WHERE id = $1
    RETURNING id
  `, [userId])
  return rows.length > 0
}

export async function createRefreshSession({
  expiresAt,
  id,
  issuedAt,
  tokenHash,
  userId,
}: RefreshSessionInput) {
  if (expiresAt <= issuedAt) throw new Error('Refresh session must expire after it is issued')

  await getSql().query(`
    INSERT INTO refresh_sessions (id, user_id, token_hash, issued_at, expires_at)
    VALUES ($1, $2, $3, $4, $5)
  `, [id, userId, tokenHash, issuedAt, expiresAt])
}

export async function rotateRefreshSession({
  expiresAt,
  id,
  issuedAt,
  now,
  previousSessionId,
  previousTokenHash,
  tokenHash,
  userId,
}: RefreshSessionRotationInput) {
  if (expiresAt <= issuedAt) throw new Error('Refresh session must expire after it is issued')
  if (!id || !userId || !tokenHash || !previousSessionId || !previousTokenHash) {
    throw new Error('Refresh session is required')
  }
  if (id === previousSessionId || tokenHash === previousTokenHash) {
    throw new Error('Refresh session rotation requires a new token')
  }

  // ponytail: opportunistic cleanup is sufficient at current volume; move it to a scheduled job if refresh traffic grows.
  const rows = await getSql().query(`
    WITH expired AS (
      DELETE FROM refresh_sessions
      WHERE expires_at <= $1
    ), revoked AS (
      UPDATE refresh_sessions
      SET revoked_at = $1
      WHERE id = $2
        AND user_id = $3
        AND token_hash = $4
        AND revoked_at IS NULL
        AND expires_at > $1
      RETURNING id
    ), replacement AS (
      INSERT INTO refresh_sessions (id, user_id, token_hash, issued_at, expires_at)
      SELECT $5, $3, $6, $7, $8
      WHERE EXISTS (SELECT 1 FROM revoked)
      RETURNING id
    )
    SELECT id FROM replacement
  `, [
    now,
    previousSessionId,
    userId,
    previousTokenHash,
    id,
    tokenHash,
    issuedAt,
    expiresAt,
  ])

  return rows.length > 0
}

export async function deleteRefreshSession(userId: string, sessionId: string) {
  if (!userId || !sessionId) throw new Error('Refresh session is required')

  await getSql().query(`
    DELETE FROM refresh_sessions
    WHERE id = $1 AND user_id = $2
  `, [sessionId, userId])
}
