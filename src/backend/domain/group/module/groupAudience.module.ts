import { PrismaModule } from '../../../global/database/prisma.module';
import { Module } from '@nestjs/common';
import { GroupRepositoryModule } from './groupRepository.module';
import { GroupAudienceReader } from '../repository/groupAudience.reader';

@Module({
  imports: [PrismaModule, GroupRepositoryModule],
  providers: [GroupAudienceReader],
  exports: [GroupAudienceReader],
})
export class GroupAudienceModule {}
