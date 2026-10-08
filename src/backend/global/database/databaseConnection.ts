import type { Prisma, PrismaClient } from '../../generated/prisma/client';
export type Database = {
  prisma: PrismaClient | Prisma.TransactionClient;
};
