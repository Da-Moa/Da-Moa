import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../global/database/prisma.module';
import { StorageModule } from '../../../global/storage/storage.module';
import { SettleRepositoryModule } from './settleRepository.module';
import { ReceiptWorker } from '../service/receiptWorker';

@Module({
  imports: [PrismaModule, StorageModule, SettleRepositoryModule],
  providers: [ReceiptWorker],
  exports: [ReceiptWorker],
})
export class ReceiptWorkerModule {}
