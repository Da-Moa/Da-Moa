import { GroupModule } from '../../group';
import { SettleModule } from '../../settle';
import { AuthorizationModule } from '../../../global/auth/module/authorization.module';
import { Module } from '@nestjs/common';
import { UserController } from '../controller/user.controller';
import { UserService } from '../service/user.service';
import { UserRepository } from '../repository/user.repository';
import { PrismaModule } from '../../../global/database/prisma.module';

@Module({
  imports: [PrismaModule, AuthorizationModule, GroupModule, SettleModule],
  controllers: [UserController],
  providers: [UserService, UserRepository],
  exports: [UserService],
})
export class UserModule {}
