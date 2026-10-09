import { Module } from '@nestjs/common'
import { ApiController } from '../controller/api.controller'
import { ApiFallbackController } from '../controller/apiFallback.controller'
import { OpenApiService } from '../openApi.service'

@Module({
  controllers: [ApiController, ApiFallbackController],
  providers: [OpenApiService],
  exports: [OpenApiService],
})
export class ApiModule {}
