import { Module } from '@nestjs/common';
import { AuthController } from '../controller/auth.controller';
import { AuthService } from '../service/auth.service';
import { KakaoController } from '../controller/kakao.controller';
import { KakaoAuthService } from '../service/kakaoAuth.service';
import { UserModule } from '../../../domain/user/module/user.module';
import { PrismaModule } from '../../database/prisma.module';
@Module({
  imports: [PrismaModule, UserModule],
  controllers: [AuthController, KakaoController],
  providers: [AuthService, KakaoAuthService],
  exports: [AuthService],
})
export class AuthModule {}
