import type { AccessToken } from '../auth/native';
import { Inject, Injectable } from '@nestjs/common';
import { AuthorizationService } from '../auth/service/authorization.service';
import { PrismaService } from '../database/prisma.service';
import { type Database } from '../database/db';
import { mutationDigest, mutationResult } from './mutations';
import { MutationRepository } from '../database/mutation.repository';
import type { MutationResult } from '../../../shared/domainTypes';

export type Identity = AccessToken | null;

@Injectable()
export class MutationExecutor {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthorizationService)
    private readonly authorization: AuthorizationService,
    @Inject(MutationRepository) private readonly requests: MutationRepository,
  ) {}
  async execute(
    access: Identity,
    key: string,
    operation: string,
    payload: unknown,
    work: (client: Database, userId: string) => Promise<MutationResult>,
  ): Promise<MutationResult> {
    return this.prisma.withWriteTransaction(async (client) => {
      const account = await this.authorization.requireAccount(client, access);
      const digest = mutationDigest(key, payload);
      const saved = await this.requests.findReplay(
        client,
        account.id,
        operation,
        key,
      );
      const replay = mutationResult<MutationResult>(saved ?? undefined, digest);
      if (replay) return replay;
      const result = await work(client, account.id);
      await this.requests.save(
        client,
        account.id,
        operation,
        key,
        digest,
        result.id,
        result,
      );
      return result;
    });
  }
}
