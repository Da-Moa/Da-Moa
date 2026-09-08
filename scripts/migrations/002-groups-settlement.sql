CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  base_currency TEXT NOT NULL CHECK (base_currency IN ('USD', 'KRW', 'JPY')),
  created_at BIGINT NOT NULL
);
CREATE TABLE group_members (
  group_id TEXT NOT NULL REFERENCES groups(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  joined_at BIGINT NOT NULL,
  left_at BIGINT,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX group_members_active_user_idx ON group_members(user_id) WHERE left_at IS NULL;
CREATE TABLE group_invites (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL CHECK (expires_at > created_at),
  revoked_at BIGINT
);
CREATE TABLE rounds (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  currency TEXT NOT NULL CHECK (currency IN ('USD', 'KRW', 'JPY')),
  status TEXT NOT NULL DEFAULT 'RECORDING' CHECK (status IN ('RECORDING', 'CONFIRMED', 'LOCKED', 'COMPLETED')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at BIGINT NOT NULL,
  confirmed_at BIGINT,
  locked_at BIGINT,
  finalized_at BIGINT,
  completed_at BIGINT,
  CHECK (
    (status = 'RECORDING' AND confirmed_at IS NULL AND locked_at IS NULL AND finalized_at IS NULL AND completed_at IS NULL)
    OR (status = 'CONFIRMED' AND confirmed_at IS NOT NULL AND locked_at IS NULL AND finalized_at IS NULL AND completed_at IS NULL)
    OR (status = 'LOCKED' AND confirmed_at IS NOT NULL AND locked_at IS NOT NULL AND completed_at IS NULL)
    OR (status = 'COMPLETED' AND confirmed_at IS NOT NULL AND locked_at IS NOT NULL AND finalized_at IS NOT NULL AND completed_at IS NOT NULL)
  ),
  CHECK (confirmed_at IS NULL OR confirmed_at >= created_at),
  CHECK (locked_at IS NULL OR locked_at >= confirmed_at),
  CHECK (finalized_at IS NULL OR finalized_at >= locked_at),
  CHECK (completed_at IS NULL OR completed_at >= finalized_at)
);
CREATE INDEX rounds_group_created_idx ON rounds(group_id, created_at, id);
CREATE TABLE round_members (
  round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  display_name_snapshot TEXT NOT NULL,
  joined_at BIGINT NOT NULL,
  excluded_at BIGINT,
  PRIMARY KEY (round_id, user_id)
);
CREATE INDEX round_members_user_idx ON round_members(user_id, round_id);
CREATE TABLE expenses (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  payer_id TEXT NOT NULL,
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 500),
  amount_minor NUMERIC NOT NULL CHECK (amount_minor > 0 AND amount_minor = trunc(amount_minor) AND amount_minor::TEXT NOT IN ('NaN', 'Infinity', '-Infinity')),
  split_mode TEXT NOT NULL CHECK (split_mode IN ('ALL', 'SELECTED')),
  base_share_minor NUMERIC CHECK (base_share_minor >= 0 AND base_share_minor = trunc(base_share_minor) AND base_share_minor::TEXT NOT IN ('NaN', 'Infinity', '-Infinity')),
  remainder_units INTEGER CHECK (remainder_units >= 0),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  updated_by TEXT NOT NULL REFERENCES users(id),
  UNIQUE (id, round_id),
  FOREIGN KEY (round_id, author_id) REFERENCES round_members(round_id, user_id),
  FOREIGN KEY (round_id, payer_id) REFERENCES round_members(round_id, user_id),
  CHECK ((base_share_minor IS NULL) = (remainder_units IS NULL))
);
CREATE INDEX expenses_round_created_idx ON expenses(round_id, created_at, id);
CREATE TABLE expense_shares (
  expense_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  round_id TEXT NOT NULL,
  final_amount_minor NUMERIC CHECK (final_amount_minor >= 0 AND final_amount_minor = trunc(final_amount_minor) AND final_amount_minor::TEXT NOT IN ('NaN', 'Infinity', '-Infinity')),
  received_remainder BOOLEAN,
  PRIMARY KEY (expense_id, user_id),
  FOREIGN KEY (expense_id, round_id) REFERENCES expenses(id, round_id) ON DELETE CASCADE,
  FOREIGN KEY (round_id, user_id) REFERENCES round_members(round_id, user_id),
  CHECK ((final_amount_minor IS NULL) = (received_remainder IS NULL))
);
CREATE TABLE expense_receipts (
  id TEXT PRIMARY KEY,
  expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 2097152),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content BYTEA NOT NULL,
  created_at BIGINT NOT NULL,
  CHECK (byte_size = octet_length(content))
);
CREATE INDEX expense_receipts_expense_idx ON expense_receipts(expense_id);
CREATE TABLE settlement_balances (
  round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  paid_minor NUMERIC NOT NULL CHECK (paid_minor >= 0 AND paid_minor = trunc(paid_minor) AND paid_minor::TEXT NOT IN ('NaN', 'Infinity', '-Infinity')),
  burden_minor NUMERIC NOT NULL CHECK (burden_minor >= 0 AND burden_minor = trunc(burden_minor) AND burden_minor::TEXT NOT IN ('NaN', 'Infinity', '-Infinity')),
  balance_minor NUMERIC NOT NULL CHECK (balance_minor = trunc(balance_minor) AND balance_minor::TEXT NOT IN ('NaN', 'Infinity', '-Infinity')),
  PRIMARY KEY (round_id, user_id),
  FOREIGN KEY (round_id, user_id) REFERENCES round_members(round_id, user_id),
  CHECK (balance_minor = burden_minor - paid_minor)
);
CREATE TABLE settlement_transfers (
  round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL,
  receiver_id TEXT NOT NULL,
  amount_minor NUMERIC NOT NULL CHECK (amount_minor > 0 AND amount_minor = trunc(amount_minor) AND amount_minor::TEXT NOT IN ('NaN', 'Infinity', '-Infinity')),
  PRIMARY KEY (round_id, sender_id, receiver_id),
  FOREIGN KEY (round_id, sender_id) REFERENCES round_members(round_id, user_id),
  FOREIGN KEY (round_id, receiver_id) REFERENCES round_members(round_id, user_id),
  CHECK (sender_id <> receiver_id)
);
CREATE TABLE mutation_requests (
  actor_id TEXT NOT NULL REFERENCES users(id),
  operation TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  resource_id TEXT,
  response_metadata JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (actor_id, operation, request_key)
);
