import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../global/database/prisma.module';
import { GroupRepository } from '../repository/group.repository';

@Module({
  imports: [PrismaModule],
  providers: [GroupRepository],
  exports: [GroupRepository],
})
export class GroupRepositoryModule {}
