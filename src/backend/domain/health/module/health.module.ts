import { Module } from '@nestjs/common';
import { HealthController } from '../controller/health.controller';
import {
  HealthService,
  HEALTH_WORKER_PROBES,
  type HealthWorkerProbes,
} from '../service/health.service';
import { HealthRepository } from '../repository/health.repository';
import { PrismaModule } from '../../../global/database/prisma.module';
import { checkReceiptWorker, checkReceiptWorkerReady } from '../../settle';
@Module({
  imports: [PrismaModule],
  controllers: [HealthController],
  providers: [
    HealthService,
    HealthRepository,
    {
      provide: HEALTH_WORKER_PROBES,
      useFactory: () =>
        ({
          worker: checkReceiptWorker,
          workerReady: checkReceiptWorkerReady,
        }) satisfies HealthWorkerProbes,
    },
  ],
})
export class HealthModule {}
