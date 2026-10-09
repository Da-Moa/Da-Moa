import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import type { MutationResult } from '../../../shared/domainTypes';
import type { Database } from './databaseConnection';
import { rethrowDatabaseError } from './databaseError';

@Injectable()
export class MutationRepository {
  findReplay(
    client: Database,
    actorId: string,
    operation: string,
    key: string,
  ) {
    return client.prisma.mutation_requests
      .findUnique({
        where: {
          actor_id_operation_request_key: {
            actor_id: actorId,
            operation,
            request_key: key,
          },
        },
        select: { request_digest: true, response_metadata: true },
      })
      .catch(rethrowDatabaseError);
  }

  async save(
    client: Database,
    actorId: string,
    operation: string,
    key: string,
    digest: string,
    resourceId: string,
    result: MutationResult,
  ) {
    await client.prisma.mutation_requests
      .create({
        data: {
          actor_id: actorId,
          operation,
          request_key: key,
          request_digest: digest,
          resource_id: resourceId,
          response_metadata: JSON.parse(
            JSON.stringify(result),
          ) as Prisma.InputJsonValue,
          created_at: BigInt(Math.floor(Date.now() / 1000)),
        },
        select: { request_key: true },
      })
      .catch(rethrowDatabaseError);
  }
}
