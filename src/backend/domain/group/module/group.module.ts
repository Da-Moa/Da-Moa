import { RealtimeModule } from '../../../global/websocket/module/realtime.module';
import { AuthorizationModule } from '../../../global/auth/module/authorization.module';
import { Module } from '@nestjs/common';
import { GroupController } from '../controller/group.controller';
import { GroupService } from '../service/group.service';
import { GroupRepositoryModule } from './groupRepository.module';
import { PrismaModule } from '../../../global/database/prisma.module';

@Module({
  imports: [
    RealtimeModule,
    PrismaModule,
    AuthorizationModule,
    GroupRepositoryModule,
  ],
  controllers: [GroupController],
  providers: [GroupService],
  exports: [GroupService],
})
export class GroupModule {}
