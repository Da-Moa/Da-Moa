ALTER TABLE settlement_transfers
  ADD COLUMN received_at BIGINT,
  ADD CONSTRAINT settlement_transfers_received_at_check
    CHECK (received_at IS NULL OR received_at >= 0);

-- Carry the prior receiver-level confirmation to each of that receiver's transfers.
UPDATE settlement_transfers t
SET received_at = rm.settlement_checked_at
FROM round_members rm
WHERE rm.round_id = t.round_id
  AND rm.user_id = t.receiver_id
  AND rm.settlement_checked_at IS NOT NULL;

ALTER TABLE round_members
  DROP CONSTRAINT round_members_settlement_checked_at_check,
  DROP COLUMN settlement_checked_at;
