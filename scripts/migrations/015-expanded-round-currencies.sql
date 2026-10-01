-- Extend the allowlist without changing historical currencies or minor-unit amounts.
ALTER TABLE rounds DROP CONSTRAINT rounds_currency_check;
ALTER TABLE rounds ADD CONSTRAINT rounds_currency_check CHECK (currency IN (
  'KRW', 'USD', 'JPY', 'VND', 'CNY', 'THB', 'TWD', 'PHP', 'HKD', 'SGD', 'MOP',
  'MYR', 'IDR', 'EUR', 'GBP', 'CHF', 'AUD', 'CAD', 'KHR', 'LAK', 'RUB', 'TRY',
  'MNT', 'CZK', 'HUF', 'NZD', 'PLN', 'NOK', 'SEK', 'DKK', 'AED', 'INR', 'NPR',
  'LKR', 'MVR', 'UZS', 'KZT', 'MXN', 'EGP', 'ZAR', 'GEL'
));
