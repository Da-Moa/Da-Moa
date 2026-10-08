import { Controller, Get } from '@nestjs/common'
import { openApiDocument } from '../../util/openapi'

@Controller()
export class ApiController {
  @Get('api/openapi.json')
  openapi() { return openApiDocument }

}
