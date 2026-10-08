import { PrismaModule } from '../../../global/database/prisma.module';
import { Module } from '@nestjs/common';
import { SettleRepositoryModule } from './settleRepository.module';
import { SettleAudienceReader } from '../repository/settleAudience.reader';

@Module({
  imports: [PrismaModule, SettleRepositoryModule],
  providers: [SettleAudienceReader],
  exports: [SettleAudienceReader],
})
export class SettleAudienceModule {}
