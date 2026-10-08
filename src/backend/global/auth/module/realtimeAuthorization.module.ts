import { Module } from '@nestjs/common';
import { RealtimeUserModule } from '../../../domain/user/native';
import { RealtimeAuthorizationService } from '../service/realtimeAuthorization.service';

@Module({
  imports: [RealtimeUserModule],
  providers: [RealtimeAuthorizationService],
  exports: [RealtimeAuthorizationService],
})
export class RealtimeAuthorizationModule {}
