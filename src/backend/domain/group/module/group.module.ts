import { AuthorizationModule } from '../../../global/auth/module/authorization.module';
import { Module } from '@nestjs/common';
import { GroupController } from '../controller/group.controller';
import { GroupService } from '../service/group.service';
import { GroupRepositoryModule } from './groupRepository.module';
import { PrismaModule } from '../../../global/database/prisma.module';

@Module({
  imports: [PrismaModule, AuthorizationModule, GroupRepositoryModule],
  controllers: [GroupController],
  providers: [GroupService],
  exports: [GroupService],
})
export class GroupModule {}
