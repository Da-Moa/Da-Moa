import { Inject, Injectable } from '@nestjs/common';
import {
  PrismaService,
  databaseRows,
} from '../../../global/database/prisma.service';
@Injectable()
export class RealtimeUserRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}
  async findState(userId: string) {
    const account = await this.prisma.client.users.findUnique({
      where: { id: userId },
      select: { id: true, deleted_at: true, onboarding_completed_at: true },
    });
    return account
      ? databaseRows<{
          id: string;
          deleted_at: string | null;
          onboarding_completed_at: string | null;
        }>(account)
      : undefined;
  }
}
