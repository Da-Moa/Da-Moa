import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Equals,
  IsBoolean,
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export class BankAccountRequestDTO {
  @ApiProperty({ pattern: '^\\d{3}$' })
  @IsString()
  @Matches(/^\d{3}$/)
  bankCode!: string;

  @ApiProperty({
    maxLength: 64,
    description: '선행 0을 보존하는 계좌번호 문자열',
  })
  @IsString()
  @MaxLength(64)
  @Matches(/^[\d -]+$/)
  accountNumber!: string;

  @ApiProperty({ minLength: 1, maxLength: 100 })
  @IsString()
  @Matches(/\S/)
  @MaxLength(100)
  accountHolder!: string;

  @ApiProperty({ type: 'integer', minimum: 0, maximum: 2_147_483_646 })
  @IsInt()
  @Min(0)
  @Max(2_147_483_646)
  expectedBankVersion!: number;

  @ApiPropertyOptional({
    enum: [false],
    description: '자동 계좌 확인은 지원하지 않음',
  })
  @ValidateIf((_, value) => value !== undefined)
  @Equals(false)
  verifyWithOpenBanking?: false;
  [key: string]: unknown;
}
export class OnboardingRequestDTO extends BankAccountRequestDTO {
  @ApiPropertyOptional({ type: Boolean })
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  confirmRejoin?: boolean;
}
