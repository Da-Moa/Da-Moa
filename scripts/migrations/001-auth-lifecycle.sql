CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (provider, provider_subject)
);
CREATE TABLE IF NOT EXISTS refresh_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  issued_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  revoked_at BIGINT,
  CHECK (expires_at > issued_at)
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_image_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_completed_at BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_number TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_holder TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_updated_at BIGINT;
ALTER TABLE users ADD CONSTRAINT users_bank_account_check CHECK (
  (bank_name IS NULL AND account_number IS NULL AND account_holder IS NULL AND bank_updated_at IS NULL)
  OR (bank_name IS NOT NULL AND account_number IS NOT NULL AND account_holder IS NOT NULL
      AND bank_updated_at IS NOT NULL AND length(bank_name) BETWEEN 1 AND 100
      AND account_number ~ '^[0-9]{1,64}$' AND length(account_holder) BETWEEN 1 AND 100)
);
ALTER TABLE users ADD CONSTRAINT users_onboarding_check CHECK (
  onboarding_completed_at IS NULL OR (bank_name IS NOT NULL AND account_number IS NOT NULL AND account_holder IS NOT NULL)
);
ALTER TABLE refresh_sessions ADD COLUMN IF NOT EXISTS revoked_at BIGINT;
ALTER TABLE refresh_sessions ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'app';
ALTER TABLE refresh_sessions ADD CONSTRAINT refresh_sessions_purpose_check CHECK (purpose IN ('app', 'onboarding'));
ALTER TABLE refresh_sessions DROP CONSTRAINT IF EXISTS refresh_sessions_user_id_fkey;
ALTER TABLE refresh_sessions ADD CONSTRAINT refresh_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);
CREATE INDEX IF NOT EXISTS refresh_sessions_active_user_idx ON refresh_sessions(user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS refresh_sessions_expiry_idx ON refresh_sessions(expires_at);
-- Run once: existing accounts must register a bank account after this migration.
UPDATE refresh_sessions SET revoked_at = extract(epoch FROM now())::BIGINT WHERE revoked_at IS NULL;
