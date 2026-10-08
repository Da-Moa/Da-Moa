import { Injectable } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from '../../generated/prisma/client';
import { createDatabasePool } from './dbClient.mjs';
import type { Database } from './databaseConnection';

function url() {
  const value = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!value) throw new Error('DATABASE_URL is required');
  return value;
}

// Preserve PostgreSQL numeric/string DTOs; Prisma uses bigint and Decimal internally.
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

@Injectable()
export class PrismaService {
  private readonly resources = new Map<
    string,
    { client: PrismaClient; pool: ReturnType<typeof createDatabasePool> }
  >();
  private closing?: Promise<void>;
  get client() {
    return this.clientFor(url());
  }
  clientFor(value: string) {
    return this.resource(value).client;
  }
  poolFor(value: string) {
    return this.resource(value).pool;
  }
  private resource(value: string) {
    if (this.closing) throw new Error('Application database is closed');
    let resource = this.resources.get(value);
    if (!resource) {
      const schema = new URL(value).searchParams.get('schema') ?? 'public';
      const pool = createDatabasePool(value);
      // Prisma disposes its adapter; this Provider owns and closes the external pg Pool.
      const client = new PrismaClient({
        adapter: new PrismaPg(pool, {
          schema,
          disposeExternalPool: false,
        }),
        transactionOptions: { maxWait: 10_000, timeout: 30_000 },
      });
      resource = { client, pool };
      this.resources.set(value, resource);
    }
    return resource;
  }
  close() {
    this.closing ??= (async () => {
      const resources = [...this.resources.values()];
      const results = await Promise.allSettled(
        resources.map(async ({ client, pool }) => {
          try {
            await client.$disconnect();
          } finally {
            await pool.end();
          }
        }),
      );
      this.resources.clear();
      const failed = results.filter(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      );
      if (failed.length)
        throw new AggregateError(
          failed.map((result) => result.reason),
          'Database shutdown failed',
        );
    })();
    return this.closing;
  }
  connection(prisma: Database['prisma'] = this.client): Database {
    return {
      prisma,
      query: (sql, parameters) =>
        this.query({ prisma } as Database, sql, parameters),
    };
  }

  async query<R = any>(
    context: Database,
    sql: string,
    parameters: unknown[] = [],
  ): Promise<{ rows: R[]; rowCount: number }> {
    // SQL is a repository-owned constant; all user values remain bound parameters.
    const command = sqlCommand(sql);
    try {
      if (
        command === 'SELECT' ||
        command === 'SHOW' ||
        /\bRETURNING\b/i.test(topLevelSql(sql))
      ) {
        const rows = databaseRows<R[]>(
          await context.prisma.$queryRawUnsafe(sql, ...parameters),
        );
        return { rows, rowCount: rows.length };
      }
      return {
        rows: [],
        rowCount: await context.prisma.$executeRawUnsafe(sql, ...parameters),
      };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2010'
      ) {
        const meta = error.meta as
          | {
              code?: string;
              message?: string;
              driverAdapterError?: {
                cause?: { originalCode?: string; originalMessage?: string };
              };
            }
          | undefined;
        const cause = meta?.driverAdapterError?.cause;
        const message =
          cause?.originalMessage ?? meta?.message ?? 'Database query failed';
        throw Object.assign(new Error(message), {
          code: cause?.originalCode ?? meta?.code,
          constraint: message.match(/constraint "([^"]+)"/)?.[1],
        });
      }
      throw error;
    }
  }

  async withDatabaseConnection<T>(
    work: (client: Database, discard: () => void) => Promise<T>,
  ) {
    return work(this.connection(), () => {});
  }

  async withWriteLock<T>(
    _client: Database,
    _discard: () => void,
    work: (client: Database) => Promise<T>,
  ) {
    return this.withWriteTransaction(work);
  }

  async withWriteTransaction<T>(
    work: (client: Database) => Promise<T>,
    beforeLock?: (client: Database) => Promise<void>,
    beforeBegin?: (client: Database) => Promise<void>,
  ) {
    await beforeBegin?.(this.connection());
    return this.client.$transaction(async (tx) => {
      const client = this.connection(tx);
      await beforeLock?.(client);
      // ponytail: retain the global write lock; use ordered domain locks when contention warrants it.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(1684106607)::text`;
      return work(client);
    });
  }

  withReadTransaction<T>(work: (client: Database) => Promise<T>) {
    return this.client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        return work(this.connection(tx));
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}

function topLevelSql(sql: string) {
  let depth = 0,
    quote = '',
    result = '';
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    if (quote) {
      if (char === quote) {
        if (sql[i + 1] === quote) i++;
        else quote = '';
      }
    } else if (char === "'" || char === '"') quote = char;
    else if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (!depth) result += char;
  }
  return result;
}
function sqlCommand(sql: string) {
  return topLevelSql(sql)
    .match(/\b(SELECT|SHOW|INSERT|UPDATE|DELETE|SET)\b/i)?.[1]
    ?.toUpperCase();
}
