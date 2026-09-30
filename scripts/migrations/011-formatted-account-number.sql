ALTER TABLE users ADD COLUMN IF NOT EXISTS account_number_formatted TEXT;
ALTER TABLE users ADD CONSTRAINT users_account_number_formatted_check CHECK (
  account_number_formatted IS NULL OR (
    account_number IS NOT NULL
    AND account_number_formatted ~ '^[0-9]+(-[0-9]+)*$'
    AND replace(account_number_formatted, '-', '') = account_number
  )
);
