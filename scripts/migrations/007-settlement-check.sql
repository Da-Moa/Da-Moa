ALTER TABLE round_members
  ADD COLUMN settlement_checked_at BIGINT,
  ADD CONSTRAINT round_members_settlement_checked_at_check
    CHECK (settlement_checked_at IS NULL OR settlement_checked_at >= joined_at);

-- Existing completed rounds predate manual confirmation and must remain complete.
UPDATE round_members rm
SET settlement_checked_at = r.completed_at
FROM rounds r
WHERE r.id = rm.round_id
  AND r.status = 'COMPLETED'
  AND (
    rm.excluded_at IS NULL
    OR EXISTS (
      SELECT 1 FROM settlement_transfers t
      WHERE t.round_id = rm.round_id
        AND (t.sender_id = rm.user_id OR t.receiver_id = rm.user_id)
    )
  );
