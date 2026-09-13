ALTER TABLE users ADD COLUMN bank_code TEXT;
ALTER TABLE users ADD COLUMN bank_verified_at BIGINT;
ALTER TABLE users ADD COLUMN bank_verification_tran_id TEXT;
ALTER TABLE users ADD COLUMN bank_version INTEGER NOT NULL DEFAULT 0 CHECK (bank_version >= 0);
ALTER TABLE users ADD CONSTRAINT users_bank_verification_check CHECK (
  (bank_verified_at IS NULL AND bank_verification_tran_id IS NULL)
  OR (bank_verified_at IS NOT NULL AND bank_verification_tran_id IS NOT NULL AND bank_code IS NOT NULL)
);
CREATE SEQUENCE openbanking_bank_tran_seq AS BIGINT START 1 MAXVALUE 101559956668415 NO CYCLE;

CREATE TABLE openbanking_connections (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  connection_id UUID NOT NULL UNIQUE,
  environment TEXT NOT NULL CHECK (environment IN ('test', 'production')),
  status TEXT NOT NULL CHECK (status IN ('CONNECTED', 'REAUTH_REQUIRED', 'DISCONNECT_PENDING', 'DISCONNECTED')),
  user_seq_no TEXT,
  access_token TEXT,
  refresh_token TEXT,
  expires_at BIGINT,
  refresh_expires_at BIGINT,
  scope TEXT,
  authenticated_at BIGINT,
  version INTEGER NOT NULL DEFAULT 0,
  operation_id UUID,
  operation_kind TEXT CHECK (operation_kind IN ('refresh', 'disconnect')),
  operation_started_at BIGINT,
  operation_finished_at BIGINT,
  operation_outcome TEXT CHECK (operation_outcome IN ('in_progress', 'unknown')),
  operation_lease_until BIGINT,
  disconnect_requested_at BIGINT,
  disconnect_attempts INTEGER NOT NULL DEFAULT 0,
  disconnect_next_attempt_at BIGINT,
  disconnect_last_error TEXT,
  disconnected_at BIGINT,
  verification_window_at BIGINT,
  verification_count INTEGER NOT NULL DEFAULT 0,
  CHECK (status <> 'CONNECTED' OR (user_seq_no IS NOT NULL AND access_token IS NOT NULL AND expires_at IS NOT NULL)),
  CHECK (status <> 'DISCONNECTED' OR (access_token IS NULL AND refresh_token IS NULL))
);
CREATE INDEX openbanking_disconnect_due_idx ON openbanking_connections(disconnect_next_attempt_at)
  WHERE status = 'DISCONNECT_PENDING';

CREATE TABLE openbanking_oauth_states (
  state_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL REFERENCES refresh_sessions(id),
  connection_id UUID NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('test', 'production')),
  context TEXT NOT NULL CHECK (context IN ('onboarding', 'settings')),
  return_to TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  used_at BIGINT,
  invalidated_at BIGINT,
  exchange_started_at BIGINT,
  exchange_finished_at BIGINT,
  exchange_outcome TEXT CHECK (exchange_outcome IN ('in_progress', 'unknown')),
  -- A response after logout/withdrawal is retained solely for eventual withdrawal cleanup.
  cleanup_user_seq_no TEXT,
  cleanup_access_token TEXT,
  cleanup_refresh_token TEXT,
  cleanup_expires_at BIGINT,
  cleanup_refresh_expires_at BIGINT,
  cleanup_scope TEXT,
  cleanup_operation_id UUID,
  cleanup_started_at BIGINT,
  cleanup_outcome TEXT CHECK (cleanup_outcome IN ('in_progress', 'unknown')),
  cleaned_at BIGINT
);
CREATE INDEX openbanking_oauth_user_idx ON openbanking_oauth_states(user_id);

CREATE TABLE openbanking_service_tokens (
  environment TEXT PRIMARY KEY CHECK (environment IN ('test', 'production')),
  access_token TEXT,
  expires_at BIGINT,
  version INTEGER NOT NULL DEFAULT 0,
  operation_id UUID,
  operation_outcome TEXT CHECK (operation_outcome IN ('in_progress', 'unknown')),
  lease_until BIGINT
);
