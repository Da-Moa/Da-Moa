ALTER TABLE expense_receipts ADD COLUMN storage_status TEXT NOT NULL DEFAULT 'READY'
  CHECK (storage_status IN ('PENDING', 'READY', 'FAILED'));
ALTER TABLE expense_receipts ALTER COLUMN object_key DROP NOT NULL;
ALTER TABLE expense_receipts DROP CONSTRAINT IF EXISTS expense_receipts_storage_check;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='expense_receipts'::regclass AND attname='content' AND NOT attisdropped) THEN
    ALTER TABLE expense_receipts ADD CONSTRAINT expense_receipts_storage_check CHECK (
      (storage_status <> 'READY' AND object_key IS NULL AND content IS NULL)
      OR (storage_status = 'READY' AND ((object_key IS NOT NULL AND object_key <> '' AND content IS NULL)
        OR (object_key IS NULL AND content IS NOT NULL)))
    );
  ELSE
    ALTER TABLE expense_receipts ADD CONSTRAINT expense_receipts_storage_check CHECK (
      (storage_status <> 'READY' AND object_key IS NULL)
      OR (storage_status = 'READY' AND object_key IS NOT NULL AND object_key <> '')
    );
  END IF;
END $$;

CREATE FUNCTION cancel_receipt_upload() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM graphile_worker.remove_job('receipt:' || OLD.id::text);
  RETURN OLD;
END $$;
CREATE TRIGGER cancel_receipt_upload AFTER DELETE ON expense_receipts
  FOR EACH ROW EXECUTE FUNCTION cancel_receipt_upload();
