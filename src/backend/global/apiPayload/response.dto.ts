import { ApiProperty } from '@nestjs/swagger';

export class ApiSuccessCode {
  @ApiProperty()
  code!: string;

  @ApiProperty()
  message!: string;

  @ApiProperty({ type: Object, nullable: true, additionalProperties: true })
  detail!: unknown;
}
export class ApiResponseDto<T> {
  constructor(
    readonly meta: ApiSuccessCode,
    readonly data: T,
  ) {}
}
