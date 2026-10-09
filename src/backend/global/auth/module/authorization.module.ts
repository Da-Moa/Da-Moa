import { Module } from '@nestjs/common';
import { AccountStateModule } from '../../../domain/user/module/accountState.module';
import { PrismaModule } from '../../database/prisma.module';
import { AuthorizationService } from '../service/authorization.service';
import { MutationExecutor } from '../../util/idempotencyUtil';

@Module({
  imports: [PrismaModule, AccountStateModule],
  providers: [AuthorizationService, MutationExecutor],
  exports: [AuthorizationService, MutationExecutor],
})
export class AuthorizationModule {}
