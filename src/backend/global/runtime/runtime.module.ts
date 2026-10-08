import { Module } from '@nestjs/common';
import { PrismaModule } from '../database/prisma.module';
import { ReceiptWorkerModule } from '../../domain/settle/module/receiptWorker.module';
import { RealtimeAuthorizationModule } from '../auth/module/realtimeAuthorization.module';
import { RealtimeModule } from '../websocket/module/realtime.module';
import { RateLimitService } from '../rateLimit/rateLimit.service';
import { RealtimeTransport } from '../websocket/realtimeTransport';
import { MetricsServer } from '../monitoring/metricsServer';
import { FrontendRuntime } from './frontendRuntime';
import { RuntimeLifecycle } from './runtimeLifecycle';
import { HttpDrain } from './httpDrain';

@Module({
  imports: [
    PrismaModule,
    ReceiptWorkerModule,
    RealtimeAuthorizationModule,
    RealtimeModule,
  ],
  providers: [
    RateLimitService,
    RealtimeTransport,
    MetricsServer,
    FrontendRuntime,
    RuntimeLifecycle,
    HttpDrain,
  ],
  exports: [
    RuntimeLifecycle,
    RealtimeTransport,
    RateLimitService,
    MetricsServer,
  ],
})
export class RuntimeModule {}
