import type { AccessToken } from '../auth/native';
import { Inject, Injectable } from '@nestjs/common';
import { AuthorizationService } from '../auth/service/authorization.service';
import { PrismaService } from '../database/prisma.service';
import { type Database } from '../database/db';
import { replayMutation, saveMutation } from './mutations';
import type { MutationResult } from '../../../shared/domainTypes';

export type Identity = AccessToken | null;

@Injectable()
export class MutationExecutor {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthorizationService)
    private readonly authorization: AuthorizationService,
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
      const replay = await replayMutation<MutationResult>(
        client,
        account.id,
        operation,
        key,
        payload,
      );
      if (replay.result) return replay.result;
      const result = await work(client, account.id);
      await saveMutation(
        client,
        account.id,
        operation,
        key,
        replay.digest,
        result.id,
        result,
      );
      return result;
    });
  }
}
