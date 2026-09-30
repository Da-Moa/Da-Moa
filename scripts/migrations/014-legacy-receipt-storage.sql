-- Preserve inline receipts while allowing new uploads to use object storage.
ALTER TABLE expense_receipts ADD COLUMN IF NOT EXISTS object_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS expense_receipts_object_key_key ON expense_receipts(object_key);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='expense_receipts'::regclass AND attname='content' AND NOT attisdropped) THEN
    ALTER TABLE expense_receipts ALTER COLUMN content DROP NOT NULL;
    ALTER TABLE expense_receipts ADD CONSTRAINT expense_receipts_storage_check CHECK (
      (object_key IS NOT NULL AND object_key <> '' AND content IS NULL)
      OR (object_key IS NULL AND content IS NOT NULL)
    );
  ELSE
    ALTER TABLE expense_receipts ALTER COLUMN object_key SET NOT NULL;
  END IF;
END $$;
