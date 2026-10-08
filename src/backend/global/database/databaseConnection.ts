import type { Prisma, PrismaClient } from '../../generated/prisma/client';
export type Database = {
  prisma: PrismaClient | Prisma.TransactionClient;
  query<R = any>(
    sql: string,
    parameters?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
};
