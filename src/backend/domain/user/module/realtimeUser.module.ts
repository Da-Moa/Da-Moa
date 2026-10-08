import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../global/database/prisma.module';
import { RealtimeUserRepository } from '../repository/realtimeUser.repository';

@Module({
  imports: [PrismaModule],
  providers: [RealtimeUserRepository],
  exports: [RealtimeUserRepository],
})
export class RealtimeUserModule {}
