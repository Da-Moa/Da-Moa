import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { GroupModule } from './group/module/group.module';
import { HealthModule } from './health/module/health.module';
import { SettleModule } from './settle/module/settle.module';
import { UserModule } from './user/module/user.module';
import { AuthModule } from '../global/auth/module/auth.module';
import { JwtGuard } from '../global/auth/guard/jwt.guard';
import { GlobalExceptionHandler } from '../global/apiPayload/handler/global.exception.handler';
import { OriginGuard } from '../global/apiPayload/origin.guard';
import { RequestBodyInterceptor } from '../global/apiPayload/requestBody.interceptor';
import { ApiResponseInterceptor } from '../global/apiPayload/apiResponse.interceptor';
import { ApiModule } from '../global/apiPayload/module/api.module';

@Module({
  imports: [
    HealthModule,
    GroupModule,
    SettleModule,
    UserModule,
    AuthModule,
    ApiModule,
  ],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: RequestBodyInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ApiResponseInterceptor },
    { provide: APP_GUARD, useClass: JwtGuard },
    { provide: APP_GUARD, useClass: OriginGuard },
    { provide: APP_FILTER, useClass: GlobalExceptionHandler },
  ],
})
export class AppModule {}
