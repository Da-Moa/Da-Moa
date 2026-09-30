UPDATE users SET account_number_formatted =
  substring(account_number FROM 1 FOR 6) || '-' || substring(account_number FROM 7 FOR 2) || '-' ||
  substring(account_number FROM 9 FOR 6)
WHERE bank_code = '004' AND account_number ~ '^[0-9]{14}$';

UPDATE users SET account_number_formatted =
  substring(account_number FROM 1 FOR 3) || '-' || substring(account_number FROM 4 FOR 6) || '-' ||
  substring(account_number FROM 10 FOR 2) || '-' || substring(account_number FROM 12 FOR 3)
WHERE bank_code = '003' AND account_number ~ '^[0-9]{14}$';

UPDATE users SET account_number_formatted =
  substring(account_number FROM 1 FOR 3) || '-' || substring(account_number FROM 4 FOR 3) || '-' ||
  substring(account_number FROM 7 FOR 6)
WHERE bank_code = '089' AND account_number ~ '^(1102|1001)[0-9]{8}$';
