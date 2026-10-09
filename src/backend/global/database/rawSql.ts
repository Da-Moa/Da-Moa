import type { Database } from './databaseConnection';
import { databaseRows } from './rowMapping';
import { rethrowDatabaseError } from './databaseError';

// Repository-owned SQL constants and trusted fragments only. All request values
// are bound separately; retain placeholder reuse in atomic CTE/bulk statements.
export async function rawRows<R>(
  client: Database,
  sql: string,
  values: readonly unknown[] = [],
): Promise<R[]> {
  try {
    return databaseRows<R[]>(
      await client.prisma.$queryRawUnsafe(sql, ...values),
    );
  } catch (error) {
    rethrowDatabaseError(error);
  }
}

export async function rawExecute(
  client: Database,
  sql: string,
  values: readonly unknown[] = [],
): Promise<number> {
  try {
    return await client.prisma.$executeRawUnsafe(sql, ...values);
  } catch (error) {
    rethrowDatabaseError(error);
  }
}
