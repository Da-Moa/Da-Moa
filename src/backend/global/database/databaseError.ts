import { Prisma } from '../../generated/prisma/client';

type PostgresErrorMeta = {
  code?: string;
  message?: string;
  driverAdapterError?: {
    cause?: { originalCode?: string; originalMessage?: string };
  };
};

export function rethrowDatabaseError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = error.meta as PostgresErrorMeta | undefined;
    const cause = meta?.driverAdapterError?.cause;
    const code =
      cause?.originalCode ?? (error.code === 'P2010' ? meta?.code : undefined);
    if (code) {
      const message = cause?.originalMessage ?? meta?.message ?? error.message;
      throw Object.assign(new Error(message, { cause: error }), {
        code,
        constraint: message.match(/constraint "([^"]+)"/)?.[1],
      });
    }
  }
  throw error;
}
