import type { Database } from '../../global/database/databaseConnection';
import { rawRows, rawExecute } from '../../global/database/rawSql';

// Existing fixture/inspection helpers use a pg-shaped result. This adapter is
// test-only; operational repositories explicitly choose typed rows or a count.
export type InspectionDatabase = Database & {
  query<R = any>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number }>;
};

export function inspectionDatabase(client: Database): InspectionDatabase {
  return {
    ...client,
    async query<R>(sql: string, values: unknown[] = []) {
      if (/^\s*(SELECT|SHOW|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)) {
        const rows = await rawRows<R>(client, sql, values);
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: await rawExecute(client, sql, values) };
    },
  };
}
