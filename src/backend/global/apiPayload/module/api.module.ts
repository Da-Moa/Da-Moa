import { Module } from '@nestjs/common'
import { ApiController } from '../controller/api.controller'
import { ApiFallbackController } from '../controller/apiFallback.controller'

@Module({ controllers: [ApiController, ApiFallbackController] })
export class ApiModule {}
