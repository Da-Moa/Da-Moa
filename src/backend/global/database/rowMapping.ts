import { Prisma } from '../../generated/prisma/client';

// Preserve API numeric/string fields; Prisma returns bigint and Decimal values.
export function databaseRows<T>(value: unknown): T {
  if (typeof value === 'bigint' || Prisma.Decimal.isDecimal(value))
    return String(value) as T;
  if (Array.isArray(value)) return value.map((item) => databaseRows(item)) as T;
  if (
    value &&
    typeof value === 'object' &&
    !(value instanceof Date) &&
    !(value instanceof Uint8Array)
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, databaseRows(item)]),
    ) as T;
  }
  return value as T;
}
