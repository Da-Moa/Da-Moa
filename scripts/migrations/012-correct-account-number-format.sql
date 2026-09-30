UPDATE users SET account_number_formatted =
  substring(account_number FROM 1 FOR 4) || '-' || substring(account_number FROM 5 FOR 2) || '-' ||
  substring(account_number FROM 7 FOR 7) || '-' || substring(account_number FROM 14 FOR 1)
WHERE bank_code = '004' AND account_number ~ '^[0-9]{14}$'
  AND substring(account_number FROM 5 FOR 2) NOT IN ('03', '23', '26')
  AND account_number_formatted ~ '^[0-9]{6}-[0-9]{2}-[0-9]{6}$';

UPDATE users SET account_number_formatted =
  substring(account_number FROM 1 FOR 3) || '-' || substring(account_number FROM 4 FOR 6) || '-' ||
  substring(account_number FROM 10 FOR 2) || '-' || substring(account_number FROM 12 FOR 2) || '-' ||
  substring(account_number FROM 14 FOR 1)
WHERE bank_code = '003' AND account_number ~ '^[0-9]{9}(01|02|03|04|06|07|13)[0-9]{3}$'
  AND account_number_formatted ~ '^[0-9]{3}-[0-9]{6}-[0-9]{2}-[0-9]{3}$';
