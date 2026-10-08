import { AuthorizationModule } from '../../../global/auth/module/authorization.module';
import { Module } from '@nestjs/common';
import { SettleController } from '../controller/settle.controller';
import { SettleService } from '../service/settle.service';
import { SettleRepository } from '../repository/settle.repository';
import { PrismaModule } from '../../../global/database/prisma.module';

@Module({
  imports: [PrismaModule, AuthorizationModule],
  controllers: [SettleController],
  providers: [SettleService, SettleRepository],
  exports: [SettleService],
})
export class SettleModule {}
