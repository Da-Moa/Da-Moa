import { ApiProperty } from '@nestjs/swagger';
import { ApiErrorResponseDTO } from '../../../apiPayload/error.response.dto';

export class AccessTokenResponseDTO {
  @ApiProperty()
  accessToken!: string;
  @ApiProperty({ enum: ['app', 'onboarding'] })
  purpose!: 'app' | 'onboarding';
}
export class RefreshTokenResponseDTO {
  @ApiProperty()
  accessToken!: string;
}
export class LogoutResponseDTO {
  @ApiProperty({ type: Boolean, enum: [true] })
  ok!: true;
}
// The refresh Guard deliberately returns the short native Unauthorized payload.
export class RefreshUnauthorizedResponseDTO {
  @ApiProperty({ enum: ['unauthorized'] })
  error!: 'unauthorized';
}
export class RefreshUnavailableResponseDTO extends ApiErrorResponseDTO {
  @ApiProperty({
    enum: ['refresh_unavailable'],
    example: 'refresh_unavailable',
    description:
      '인증 정보를 갱신하지 못해 동일 요청으로 재시도할 수 있습니다.',
  })
  declare error: string;
}
