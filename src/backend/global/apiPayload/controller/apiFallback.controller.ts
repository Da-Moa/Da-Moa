import { ApiExcludeController } from '@nestjs/swagger'
import { All, Controller } from '@nestjs/common'
import { AppError } from '../errors'

@ApiExcludeController()
@Controller()
export class ApiFallbackController {
  @All(['api', 'api/{*path}'])
  missing(): never {
    throw new AppError(404, 'not_found', '요청한 API를 찾을 수 없어요')
  }
}
