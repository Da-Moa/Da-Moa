ALTER TABLE expenses DROP CONSTRAINT expenses_split_mode_check;
ALTER TABLE expenses ADD CONSTRAINT expenses_split_mode_check CHECK (split_mode IN ('ALL', 'SELECTED', 'CUSTOM'));

-- Keep the entered burden separate from the final result so reopening preserves it.
ALTER TABLE expense_shares ADD COLUMN assigned_amount_minor NUMERIC CHECK (
  assigned_amount_minor > 0 AND assigned_amount_minor = trunc(assigned_amount_minor)
  AND assigned_amount_minor::TEXT NOT IN ('NaN', 'Infinity', '-Infinity')
);
