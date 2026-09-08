-- Currency is chosen per round. Existing rounds already store their own currency.
ALTER TABLE groups DROP COLUMN base_currency;
