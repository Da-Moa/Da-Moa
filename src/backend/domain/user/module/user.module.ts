import { GroupAudienceModule } from '../../group';
import { SettleAudienceModule } from '../../settle';
import { AuthorizationModule } from '../../../global/auth/module/authorization.module';
import { Module } from '@nestjs/common';
import { UserController } from '../controller/user.controller';
import { UserService } from '../service/user.service';
import { UserRepository } from '../repository/user.repository';
import { PrismaModule } from '../../../global/database/prisma.module';

@Module({
  imports: [
    PrismaModule,
    AuthorizationModule,
    GroupAudienceModule,
    SettleAudienceModule,
  ],
  controllers: [UserController],
  providers: [UserService, UserRepository],
  exports: [UserService],
})
export class UserModule {}
