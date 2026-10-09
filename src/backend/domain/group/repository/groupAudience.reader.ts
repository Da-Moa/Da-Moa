import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '../../../global/database/prisma.service';
import { GroupRepository } from './group.repository';

@Injectable()
export class GroupAudienceReader {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GroupRepository) private readonly repository: GroupRepository,
  ) {}
  findRecipients(groupIds: string[]) {
    return this.prisma.withDatabaseConnection((client) =>
      this.repository.findDepartureAudience(client, groupIds),
    );
  }
}
