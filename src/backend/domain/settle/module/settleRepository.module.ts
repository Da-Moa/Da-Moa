import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../global/database/prisma.module';
import { SettleRepository } from '../repository/settle.repository';

@Module({
  imports: [PrismaModule],
  providers: [SettleRepository],
  exports: [SettleRepository],
})
export class SettleRepositoryModule {}
