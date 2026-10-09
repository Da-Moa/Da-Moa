import { Injectable, ValidationPipe } from '@nestjs/common';
import { TestLoginRequestDTO } from '../dto/req/testLogin.request.dto';
import { AppError } from '../../apiPayload/errors';

@Injectable()
export class TestLoginBodyPipe extends ValidationPipe {
  constructor() {
    super({
      expectedType: TestLoginRequestDTO,
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      transformOptions: { enableImplicitConversion: false },
      validationError: { target: false, value: false },
      exceptionFactory: () =>
        new AppError(400, 'invalid_input', '올바른 로그인 요청이 필요합니다'),
    });
  }
}
