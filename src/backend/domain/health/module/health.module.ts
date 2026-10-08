import { Module } from '@nestjs/common';
import { HealthController } from '../controller/health.controller';
import {
  HealthService,
  HEALTH_WORKER_PROBES,
  type HealthWorkerProbes,
} from '../service/health.service';
import { HealthRepository } from '../repository/health.repository';
import { PrismaModule } from '../../../global/database/prisma.module';
import { ReceiptWorkerModule, ReceiptWorker } from '../../settle';
@Module({
  imports: [PrismaModule, ReceiptWorkerModule],
  controllers: [HealthController],
  providers: [
    HealthService,
    HealthRepository,
    {
      provide: HEALTH_WORKER_PROBES,
      inject: [ReceiptWorker],
      useFactory: (receiptWorker: ReceiptWorker) =>
        ({
          worker: () => receiptWorker.check(),
          workerReady: () => receiptWorker.checkReady(),
        }) satisfies HealthWorkerProbes,
    },
  ],
})
export class HealthModule {}
