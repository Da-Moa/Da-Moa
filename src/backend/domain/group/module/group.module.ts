import { Module } from '@nestjs/common';
import { GroupController } from '../controller/group.controller';
import { GroupService } from '../service/group.service';
import { GroupRepository } from '../repository/group.repository';
import { PrismaModule } from '../../../global/database/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [GroupController],
  providers: [GroupService, GroupRepository],
  exports: [GroupService],
})
export class GroupModule {}
