import { AuthorizationModule } from '../../../global/auth/module/authorization.module';
import { Module } from '@nestjs/common';
import { SettleController } from '../controller/settle.controller';
import { SettleService } from '../service/settle.service';
import { SettleRepositoryModule } from './settleRepository.module';
import { PrismaModule } from '../../../global/database/prisma.module';

@Module({
  imports: [PrismaModule, AuthorizationModule, SettleRepositoryModule],
  controllers: [SettleController],
  providers: [SettleService],
  exports: [SettleService],
})
export class SettleModule {}
