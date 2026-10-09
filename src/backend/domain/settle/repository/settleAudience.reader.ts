import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '../../../global/database/prisma.service';
import { SettleRepository } from './settle.repository';

@Injectable()
export class SettleAudienceReader {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SettleRepository) private readonly repository: SettleRepository,
  ) {}
  findRecipients(userId: string) {
    return this.prisma.withDatabaseConnection((client) =>
      this.repository.findBankSettlementAudience(client, userId),
    );
  }
}
