import { PrismaService } from './prisma.service';
export type { Database } from './databaseConnection';
export { createDatabaseClient } from './dbClient.mjs';
const prisma = new PrismaService();
export const withDatabaseConnection =
  prisma.withDatabaseConnection.bind(prisma);
export const withWriteLock = prisma.withWriteLock.bind(prisma);
export const withWriteTransaction = prisma.withWriteTransaction.bind(prisma);
export const withReadTransaction = prisma.withReadTransaction.bind(prisma);
