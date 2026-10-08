import { Module } from '@nestjs/common';
import { AuthController } from '../controller/auth.controller';
import { AuthService } from '../service/auth.service';
import { UserModule } from '../../../domain/user/module/user.module';
import { PrismaModule } from '../../database/prisma.module';
@Module({
  imports: [PrismaModule, UserModule],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
