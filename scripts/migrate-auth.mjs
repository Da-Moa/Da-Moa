import nextEnv from '@next/env'
import { neon } from '@neondatabase/serverless'

const { loadEnvConfig } = nextEnv

loadEnvConfig(process.cwd())

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL
if (!connectionString) throw new Error('DATABASE_URL is required')

const sql = neon(connectionString)

await sql.transaction([
  sql`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_subject TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      UNIQUE (provider, provider_subject)
    )
  `,
  sql`
    CREATE TABLE IF NOT EXISTS refresh_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      issued_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL,
      revoked_at BIGINT,
      CHECK (expires_at > issued_at)
    )
  `,
  sql`ALTER TABLE refresh_sessions ADD COLUMN IF NOT EXISTS revoked_at BIGINT`,
  sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT`,
  sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT`,
  sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_image_url TEXT`,
  sql`
    CREATE INDEX IF NOT EXISTS refresh_sessions_active_user_idx
    ON refresh_sessions(user_id)
    WHERE revoked_at IS NULL
  `,
  sql`
    CREATE INDEX IF NOT EXISTS refresh_sessions_expiry_idx
    ON refresh_sessions(expires_at)
  `,
])

console.info('Auth schema migration complete')
