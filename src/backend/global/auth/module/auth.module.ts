import { TokenModule } from './token.module';
import { Module } from '@nestjs/common';
import { AuthController } from '../controller/auth.controller';
import { AuthService } from '../service/auth.service';
import { KakaoController } from '../controller/kakao.controller';
import { KakaoAuthService } from '../service/kakaoAuth.service';
import { KakaoOidcClient } from '../service/kakaoOidc.client';
import { TestLoginGuard } from '../guard/testLogin.guard';
import { TestLoginBodyPipe } from '../pipe/testLoginBody.pipe';
import { UserModule } from '../../../domain/user/module/user.module';
import { PrismaModule } from '../../database/prisma.module';
@Module({
  imports: [TokenModule, PrismaModule, UserModule],
  controllers: [AuthController, KakaoController],
  providers: [
    AuthService,
    KakaoAuthService,
    KakaoOidcClient,
    TestLoginGuard,
    TestLoginBodyPipe,
  ],
  exports: [AuthService],
})
export class AuthModule {}
