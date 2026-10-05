-- Preserve historical currencies, amounts, final shares and receipt confirmations.
ALTER TABLE expenses ADD COLUMN currency TEXT;
ALTER TABLE settlement_balances ADD COLUMN currency TEXT;
ALTER TABLE settlement_transfers ADD COLUMN currency TEXT;
UPDATE expenses e SET currency=r.currency FROM rounds r WHERE r.id=e.round_id;
UPDATE settlement_balances b SET currency=r.currency FROM rounds r WHERE r.id=b.round_id;
UPDATE settlement_transfers t SET currency=r.currency FROM rounds r WHERE r.id=t.round_id;
-- Flush deferred historical foreign-key checks before changing table constraints.
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE expenses ALTER COLUMN currency SET NOT NULL,
  ADD CONSTRAINT expenses_currency_check CHECK (currency IN ('KRW', 'USD', 'JPY', 'VND', 'CNY', 'THB', 'TWD', 'PHP', 'HKD', 'SGD', 'MOP', 'MYR', 'IDR', 'EUR', 'GBP', 'CHF', 'AUD', 'CAD', 'KHR', 'LAK', 'RUB', 'TRY', 'MNT', 'CZK', 'HUF', 'NZD', 'PLN', 'NOK', 'SEK', 'DKK', 'AED', 'INR', 'NPR', 'LKR', 'MVR', 'UZS', 'KZT', 'MXN', 'EGP', 'ZAR', 'GEL'));
ALTER TABLE settlement_balances ALTER COLUMN currency SET NOT NULL,
  ADD CONSTRAINT settlement_balances_currency_check CHECK (currency IN ('KRW', 'USD', 'JPY', 'VND', 'CNY', 'THB', 'TWD', 'PHP', 'HKD', 'SGD', 'MOP', 'MYR', 'IDR', 'EUR', 'GBP', 'CHF', 'AUD', 'CAD', 'KHR', 'LAK', 'RUB', 'TRY', 'MNT', 'CZK', 'HUF', 'NZD', 'PLN', 'NOK', 'SEK', 'DKK', 'AED', 'INR', 'NPR', 'LKR', 'MVR', 'UZS', 'KZT', 'MXN', 'EGP', 'ZAR', 'GEL')),
  DROP CONSTRAINT settlement_balances_pkey,
  ADD PRIMARY KEY (round_id, user_id, currency);
ALTER TABLE settlement_transfers ALTER COLUMN currency SET NOT NULL,
  ADD CONSTRAINT settlement_transfers_currency_check CHECK (currency IN ('KRW', 'USD', 'JPY', 'VND', 'CNY', 'THB', 'TWD', 'PHP', 'HKD', 'SGD', 'MOP', 'MYR', 'IDR', 'EUR', 'GBP', 'CHF', 'AUD', 'CAD', 'KHR', 'LAK', 'RUB', 'TRY', 'MNT', 'CZK', 'HUF', 'NZD', 'PLN', 'NOK', 'SEK', 'DKK', 'AED', 'INR', 'NPR', 'LKR', 'MVR', 'UZS', 'KZT', 'MXN', 'EGP', 'ZAR', 'GEL')),
  DROP CONSTRAINT settlement_transfers_pkey,
  ADD PRIMARY KEY (round_id, sender_id, receiver_id, currency);
CREATE INDEX expenses_round_currency_idx ON expenses(round_id, currency);
ALTER TABLE rounds DROP COLUMN currency;
