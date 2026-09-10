ALTER TABLE expense_receipts
  DROP CONSTRAINT expense_receipts_mime_type_check,
  DROP CONSTRAINT expense_receipts_byte_size_check;

ALTER TABLE expense_receipts
  ADD CONSTRAINT expense_receipts_mime_type_check CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/avif')),
  ADD CONSTRAINT expense_receipts_byte_size_check CHECK (byte_size > 0);
