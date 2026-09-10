-- Round cancellation deletes members and expenses through separate cascade paths.
-- Check their shared participant references after all cascades have finished.
-- Committed orphan references are still rejected.
ALTER TABLE expenses ALTER CONSTRAINT expenses_round_id_author_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE expenses ALTER CONSTRAINT expenses_round_id_payer_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE expense_shares ALTER CONSTRAINT expense_shares_round_id_user_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE settlement_balances ALTER CONSTRAINT settlement_balances_round_id_user_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE settlement_transfers ALTER CONSTRAINT settlement_transfers_round_id_sender_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE settlement_transfers ALTER CONSTRAINT settlement_transfers_round_id_receiver_id_fkey DEFERRABLE INITIALLY DEFERRED;
