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

type KakaoProfileInput = {
  displayName: string | null
  email: string | null
  profileImageUrl: string | null
}

export type UserAccount = KakaoProfileInput

let schemaPromise: Promise<void> | undefined
let sql: NeonQueryFunction<false, false> | undefined

function getSql() {
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL
  if (!connectionString) throw new Error('DATABASE_URL is required')
  return sql ??= neon(connectionString)
}

async function createSchema() {
  const client = getSql()

  await client`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_subject TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      UNIQUE (provider, provider_subject)
    )
  `
  await client`
    CREATE TABLE IF NOT EXISTS refresh_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      issued_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL,
      revoked_at BIGINT,
      CHECK (expires_at > issued_at)
    )
  `
  await client`ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT`
  await client`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT`
  await client`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_image_url TEXT`
  await client`
    CREATE INDEX IF NOT EXISTS refresh_sessions_active_user_idx
    ON refresh_sessions(user_id)
    WHERE revoked_at IS NULL
  `
}

function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = createSchema().catch((error) => {
      schemaPromise = undefined
      throw error
    })
  }
  return schemaPromise
}

export async function upsertKakaoUser(providerSubject: string, profile: KakaoProfileInput, now: number) {
  if (!providerSubject) throw new Error('Kakao subject is required')

  await ensureSchema()
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
  await ensureSchema()
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

  await ensureSchema()
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

  await ensureSchema()
  await getSql().query(`
    INSERT INTO refresh_sessions (id, user_id, token_hash, issued_at, expires_at)
    VALUES ($1, $2, $3, $4, $5)
  `, [id, userId, tokenHash, issuedAt, expiresAt])
}

export async function isActiveRefreshToken(
  userId: string,
  sessionId: string,
  tokenHash: string,
  now: number,
) {
  await ensureSchema()
  const rows = await getSql().query(`
    SELECT 1
    FROM refresh_sessions
    WHERE id = $1 AND user_id = $2 AND token_hash = $3 AND revoked_at IS NULL AND expires_at > $4
  `, [sessionId, userId, tokenHash, now])
  return rows.length > 0
}

export async function deleteRefreshSession(userId: string, sessionId: string) {
  if (!userId || !sessionId) throw new Error('Refresh session is required')

  await ensureSchema()
  await getSql().query(`
    DELETE FROM refresh_sessions
    WHERE id = $1 AND user_id = $2
  `, [sessionId, userId])
}
