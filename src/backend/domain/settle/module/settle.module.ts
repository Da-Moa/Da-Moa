import { RealtimeModule } from '../../../global/websocket/module/realtime.module';
import { StorageModule } from '../../../global/storage/storage.module';
import { AuthorizationModule } from '../../../global/auth/module/authorization.module';
import { Module } from '@nestjs/common';
import { SettleController } from '../controller/settle.controller';
import { ReceiptUploadInterceptor } from '../controller/receiptUpload.interceptor';
import { SettleService } from '../service/settle.service';
import { SettleRepositoryModule } from './settleRepository.module';
import { PrismaModule } from '../../../global/database/prisma.module';

@Module({
  imports: [
    RealtimeModule,
    PrismaModule,
    AuthorizationModule,
    SettleRepositoryModule,
    StorageModule,
  ],
  controllers: [SettleController],
  providers: [SettleService, ReceiptUploadInterceptor],
  exports: [SettleService],
})
export class SettleModule {}
