import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';

@ApiSchema({ name: 'AccountBank' })
export class AccountBank {
  @ApiProperty({ type: 'string', minLength: 1, maxLength: 100 })
  bankName!: string;
  @ApiProperty({
    type: 'string',
    minLength: 1,
    maxLength: 100,
    description: '구분자 없는 원본 계좌번호. 선행 0을 보존합니다.',
  })
  accountNumber!: string;
  @ApiProperty({
    type: 'string',
    nullable: true,
    description:
      '선택 은행의 규칙으로 저장한 표시용 계좌번호. 이전에 등록한 계좌는 null일 수 있습니다.',
  })
  formattedAccountNumber!: string | null;
  @ApiProperty({ type: 'string', minLength: 1, maxLength: 100 })
  accountHolder!: string;
  @ApiProperty({ type: 'string', nullable: true })
  bankCode!: string | null;
  @ApiProperty({
    type: 'integer',
    format: 'int64',
    description: 'UTC epoch seconds',
    nullable: true,
  })
  verifiedAt!: number | null;
}
@ApiSchema({ name: 'Me' })
export class Account {
  @ApiProperty({ type: 'string', format: 'uuid' })
  id!: string;
  @ApiProperty({ type: 'string', nullable: true })
  displayName!: string | null;
  @ApiProperty({ type: 'string', nullable: true })
  email!: string | null;
  @ApiProperty({
    type: 'string',
    format: 'uri',
    nullable: true,
    description:
      '활성 회원의 최신 카카오 프로필 이미지 URL. 탈퇴했거나 이미지가 없으면 null.',
  })
  profileImageUrl!: string | null;
  @ApiProperty({ type: 'string', enum: ['app', 'onboarding'] })
  purpose!: 'app' | 'onboarding';
  @ApiProperty({
    type: 'integer',
    format: 'int64',
    description: 'UTC epoch seconds',
    nullable: true,
  })
  deletedAt!: number | null;
  @ApiProperty({
    type: 'integer',
    format: 'int64',
    description: 'UTC epoch seconds',
    nullable: true,
  })
  onboardingCompletedAt!: number | null;
  @ApiProperty({ type: 'integer', minimum: 0 })
  bankVersion!: number;
  @ApiProperty({
    nullable: true,
    description:
      '본인의 현재 대표 계좌. verifiedAt=null이면 “확인되지 않은 계좌입니다.”를 표시합니다. 계좌는 직접 입력하며 자동 확인을 제공하지 않습니다.',
    type: () => AccountBank,
  })
  bankAccount!: AccountBank | null;
}
@ApiSchema({ name: 'BankAccountResponseDTO' })
export class BankAccountResponseDTO {
  @ApiProperty({ type: 'string', format: 'uuid' })
  id!: string;
  @ApiProperty({ type: 'integer', minimum: 0 })
  bankVersion!: number;
}
@ApiSchema({ name: 'OnboardingResponseDTO' })
export class OnboardingResponseDTO {
  @ApiProperty({ type: 'string', format: 'uuid' })
  id!: string;
  @ApiProperty({ type: 'string' })
  returnTo!: string;
  @ApiProperty({ type: 'string' })
  accessToken!: string;
}
@ApiSchema({ name: 'WithdrawResponseDTO' })
export class WithdrawResponseDTO {
  @ApiProperty({ type: 'boolean', enum: [true] })
  ok!: true;
}

export type UserAccountState = {
  id: string;
  displayName: string | null;
  email: string | null;
  profileImageUrl: string | null;
  bankName: string | null;
  accountNumber: string | null;
  formattedAccountNumber: string | null;
  accountHolder: string | null;
  bankCode: string | null;
  bankVerifiedAt: number | null;
  bankVersion: number;
  updatedAt: number;
  deletedAt: number | null;
  onboardingCompletedAt: number | null;
};

export type ActiveUserProfile = {
  userId: string;
  displayName: string;
  profileImageUrl: string | null;
};
export type SignInUserDTO = Pick<
  UserAccountState,
  'id' | 'deletedAt' | 'onboardingCompletedAt'
>;

export type {
  BankAccountRequestDTO,
  OnboardingRequestDTO,
} from '../req/user.request.dto';
