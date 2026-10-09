import { Controller, Get, Inject } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { OpenApiService } from '../openApi.service';

@ApiExcludeController()
@Controller()
export class ApiController {
  constructor(@Inject(OpenApiService) private readonly docs: OpenApiService) {}

  @Get('api/openapi.json')
  openapi() {
    return this.docs.getDocument();
  }
}
