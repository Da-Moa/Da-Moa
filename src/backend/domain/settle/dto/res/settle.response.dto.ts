import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import {
  CURRENCY_CODES,
  type Currency,
} from '../../../../../shared/domain/settle/money';

const roundStatuses = [
  'RECORDING',
  'CONFIRMED',
  'LOCKED',
  'COMPLETED',
] as const;
export type RoundStatus = (typeof roundStatuses)[number];

@ApiSchema({ name: 'CurrencyTotal' })
export class CurrencyTotal {
  @ApiProperty({ type: 'string', enum: CURRENCY_CODES })
  currency!: Currency;
  @ApiProperty({
    type: 'string',
    pattern: '^\\d+$',
    description:
      '통화 최소 단위의 정확한 정수 문자열. KRW·JPY·VND는 주 단위, 나머지 지원 통화는 주 단위의 1/100.',
  })
  totalMinor!: string;
  @ApiProperty({ type: 'string', pattern: '^-?\\d+$', nullable: true })
  balanceMinor!: string | null;
}

@ApiSchema({ name: 'CurrencyBalance' })
export class CurrencyBalance {
  @ApiProperty({ type: 'string', enum: CURRENCY_CODES })
  currency!: Currency;
  @ApiProperty({ type: 'string', pattern: '^-?\\d+$' })
  balanceMinor!: string;
}

@ApiSchema({ name: 'RoundMember' })
export class RoundMember {
  @ApiProperty({ type: 'string', format: 'uuid' })
  userId!: string;
  @ApiProperty({ type: 'string' })
  displayName!: string;
  @ApiProperty({
    type: 'string',
    format: 'uri',
    nullable: true,
    description:
      '활성 회원의 최신 카카오 프로필 이미지 URL. 탈퇴했거나 이미지가 없으면 null.',
  })
  profileImageUrl!: string | null;
  @ApiProperty({
    type: 'integer',
    format: 'int64',
    description: 'UTC epoch seconds',
    nullable: true,
  })
  excludedAt!: number | null;
}

@ApiSchema({ name: 'Receipt' })
export class Receipt {
  @ApiProperty({ type: 'string', format: 'uuid' })
  id!: string;
  @ApiProperty({
    type: 'string',
    enum: ['image/avif', 'image/jpeg', 'image/png', 'image/webp'],
    description:
      '신규 업로드는 image/avif이며 나머지는 기존 저장 자료 조회 호환 값입니다.',
  })
  mimeType!: string;
  @ApiProperty({
    type: 'integer',
    minimum: 1,
    description:
      '저장할 이미지의 바이트 크기입니다. 신규 업로드 파일은 최대 10 MiB이며 기존 자료는 이 상한 이전의 파일을 포함할 수 있습니다.',
  })
  byteSize!: number;
  @ApiProperty({
    type: 'string',
    enum: ['PENDING', 'READY', 'FAILED'],
    description:
      '저장 중·조회 가능·최종 저장 실패. 실패한 영수증은 삭제 후 다시 업로드할 수 있습니다.',
  })
  storageStatus!: 'PENDING' | 'READY' | 'FAILED';
}

@ApiSchema({ name: 'ExpenseShare' })
export class ExpenseShare {
  @ApiProperty({ type: 'string', format: 'uuid' })
  userId!: string;
  @ApiProperty({
    type: 'string',
    pattern: '^\\d+$',
    description:
      'CUSTOM에서 지정한 원본 부담금. 균등 분배에서는 null이며 재오픈해도 원본은 유지됩니다.',
    nullable: true,
  })
  assignedAmountMinor!: string | null;
  @ApiProperty({
    type: 'string',
    pattern: '^\\d+$',
    description: '최종 저장된 부담금. 최종화 전에는 CUSTOM도 null입니다.',
    nullable: true,
  })
  amountMinor!: string | null;
  @ApiProperty({ type: 'boolean', nullable: true })
  receivedRemainder!: boolean | null;
}

@ApiSchema({ name: 'Expense' })
export class Expense {
  @ApiProperty({ type: 'string', format: 'uuid' })
  id!: string;
  @ApiProperty({ type: 'string', format: 'uuid' })
  authorId!: string;
  @ApiProperty({ type: 'string', format: 'uuid' })
  payerId!: string;
  @ApiProperty({ type: 'string' })
  description!: string;
  @ApiProperty({ type: 'string', enum: CURRENCY_CODES })
  currency!: Currency;
  @ApiProperty({
    type: 'string',
    pattern: '^\\d+$',
    description:
      '통화 최소 단위의 정확한 정수 문자열. KRW·JPY·VND는 주 단위, 나머지 지원 통화는 주 단위의 1/100.',
  })
  amountMinor!: string;
  @ApiProperty({ type: 'string', enum: ['ALL', 'SELECTED', 'CUSTOM'] })
  splitMode!: 'ALL' | 'SELECTED' | 'CUSTOM';
  @ApiProperty({ type: 'array', items: { type: 'string', format: 'uuid' } })
  participantIds!: string[];
  @ApiProperty({
    type: 'string',
    pattern: '^\\d+$',
    description:
      '통화 최소 단위의 정확한 정수 문자열. KRW·JPY·VND는 주 단위, 나머지 지원 통화는 주 단위의 1/100.',
    nullable: true,
  })
  baseShareMinor!: string | null;
  @ApiProperty({ type: 'integer', minimum: 0, nullable: true })
  remainderUnits!: number | null;
  @ApiProperty({ type: [ExpenseShare] })
  shares!: ExpenseShare[];
  @ApiProperty({ type: [Receipt] })
  receipts!: Receipt[];
  @ApiProperty({
    type: 'integer',
    format: 'int64',
    description: 'UTC epoch seconds',
  })
  createdAt!: number;
  @ApiProperty({
    type: 'integer',
    format: 'int64',
    description: 'UTC epoch seconds',
  })
  updatedAt!: number;
}

@ApiSchema({ name: 'SettlementTransfer' })
export class SettlementTransfer {
  @ApiProperty({ type: 'string', enum: CURRENCY_CODES })
  currency!: Currency;
  @ApiProperty({ type: 'string', format: 'uuid' })
  senderId!: string;
  @ApiProperty({ type: 'string', format: 'uuid' })
  receiverId!: string;
  @ApiProperty({
    type: 'string',
    pattern: '^\\d+$',
    description:
      '통화 최소 단위의 정확한 정수 문자열. KRW·JPY·VND는 주 단위, 나머지 지원 통화는 주 단위의 1/100.',
  })
  amountMinor!: string;
}

@ApiSchema({ name: 'PendingRemainder' })
export class PendingRemainder {
  @ApiProperty({ type: 'string', enum: CURRENCY_CODES })
  currency!: Currency;
  @ApiProperty({
    type: 'string',
    pattern: '^\\d+$',
    description:
      '통화 최소 단위의 정확한 정수 문자열. KRW·JPY·VND는 주 단위, 나머지 지원 통화는 주 단위의 1/100.',
  })
  amountMinor!: string;
}

@ApiSchema({ name: 'Round' })
export class RoundSummary {
  @ApiProperty({ type: 'string', format: 'uuid' })
  id!: string;
  @ApiProperty({ type: 'string', format: 'uuid' })
  groupId!: string;
  @ApiProperty({ type: 'string' })
  groupName!: string;
  @ApiProperty({ type: 'string' })
  name!: string;
  @ApiProperty({ type: 'string', enum: roundStatuses })
  status!: RoundStatus;
  @ApiProperty({ type: 'integer', minimum: 1 })
  version!: number;
  @ApiProperty({
    type: 'integer',
    format: 'int64',
    description: 'UTC epoch seconds',
  })
  createdAt!: number;
  @ApiProperty({
    type: 'integer',
    format: 'int64',
    description: 'UTC epoch seconds',
    nullable: true,
  })
  finalizedAt!: number | null;
  @ApiProperty({
    type: 'integer',
    format: 'int64',
    description: 'UTC epoch seconds',
    nullable: true,
  })
  completedAt!: number | null;
  @ApiProperty({
    type: [CurrencyTotal],
    maxItems: 5,
    description:
      '기록된 통화별 합계. 통화가 다른 금액은 합산하지 않습니다. 지출이 없으면 빈 배열.',
  })
  totals!: CurrencyTotal[];
  @ApiProperty({ type: 'integer', minimum: 0 })
  memberCount!: number;
}

@ApiSchema({ name: 'RoundPage' })
export class RoundPage {
  @ApiProperty({ type: [RoundSummary] })
  items!: RoundSummary[];
  @ApiProperty({ type: 'string', nullable: true })
  nextCursor!: string | null;
}

@ApiSchema({ name: 'RoundDetail' })
export class RoundDetail extends RoundSummary {
  @ApiProperty({
    type: 'string',
    format: 'uuid',
    description: '회차 생성자 ID. 해당 회차 수명주기와 전체 지출을 관리합니다.',
  })
  creatorId!: string;
  @ApiProperty({
    type: 'string',
    format: 'uuid',
    description: '소속 모임 생성자 ID. 회차 생성자와 다를 수 있습니다.',
  })
  groupCreatorId!: string;
  @ApiProperty({
    type: 'boolean',
    description: '조회 사용자가 이 회차의 생성자인지 여부',
  })
  isCreator!: boolean;
  @ApiProperty({ type: [RoundMember] })
  members!: RoundMember[];
  @ApiProperty({ type: [Expense] })
  expenses!: Expense[];
  @ApiProperty({ type: 'string', nullable: true })
  expensesNextCursor!: string | null;
  @ApiProperty({
    type: [SettlementTransfer],
    description: '조회 사용자가 보내거나 받는 송금 관계만 포함합니다.',
  })
  transfers!: SettlementTransfer[];
  @ApiProperty({ type: [PendingRemainder] })
  pendingRemainders!: PendingRemainder[];
}

@ApiSchema({ name: 'ExclusionExpense' })
export class ExclusionExpense {
  @ApiProperty({ type: 'string', format: 'uuid' })
  id!: string;
  @ApiProperty({ type: 'string' })
  description!: string;
  @ApiProperty({ type: 'string', enum: CURRENCY_CODES })
  currency!: Currency;
  @ApiProperty({
    type: 'string',
    pattern: '^\\d+$',
    description:
      '통화 최소 단위의 정확한 정수 문자열. KRW·JPY·VND는 주 단위, 나머지 지원 통화는 주 단위의 1/100.',
  })
  amountMinor!: string;
  @ApiProperty({ type: 'string', format: 'uuid' })
  authorId!: string;
  @ApiProperty({ type: 'string' })
  authorName!: string;
  @ApiProperty({ type: 'string' })
  reason!: string;
}

@ApiSchema({ name: 'ExclusionCheck' })
export class ExclusionCheck {
  @ApiProperty({ type: 'boolean' })
  allowed!: boolean;
  @ApiProperty({ type: 'string', nullable: true })
  reason!: string | null;
  @ApiProperty({ type: [ExclusionExpense] })
  expenses!: ExclusionExpense[];
}

@ApiSchema({ name: 'MutationResult' })
export class MutationResult {
  @ApiProperty({ type: 'string', format: 'uuid' })
  id!: string;
  @ApiPropertyOptional({ type: 'string', format: 'uuid' })
  roundId?: string;
  @ApiPropertyOptional({ type: 'string', enum: roundStatuses })
  status?: RoundStatus;
  @ApiPropertyOptional({ type: 'integer', minimum: 1 })
  version?: number;
}

@ApiSchema({ name: 'CurrentBankAccount' })
export class CurrentBankAccount {
  @ApiProperty({ type: 'string', nullable: true })
  bankName!: string | null;
  @ApiProperty({ type: 'string', nullable: true })
  accountNumber!: string | null;
  @ApiProperty({
    type: 'string',
    nullable: true,
    description: '저장된 표시용 번호. 이전에 등록한 계좌는 null일 수 있습니다.',
  })
  formattedAccountNumber!: string | null;
  @ApiProperty({ type: 'string', nullable: true })
  accountHolder!: string | null;
  @ApiProperty({
    type: 'integer',
    format: 'int64',
    description:
      'null이면 계좌번호와 함께 “확인되지 않은 계좌입니다.”를 표시합니다.',
    nullable: true,
  })
  verifiedAt!: number | null;
}

@ApiSchema({ name: 'SettlementConfirmation' })
export class SettlementConfirmation {
  @ApiProperty({ type: 'string', format: 'uuid' })
  userId!: string;
  @ApiProperty({ type: 'string' })
  displayName!: string;
  @ApiProperty({
    type: 'string',
    format: 'uri',
    nullable: true,
    description:
      '활성 회원의 최신 카카오 프로필 이미지 URL. 탈퇴했거나 이미지가 없으면 null.',
  })
  profileImageUrl!: string | null;
  @ApiProperty({
    type: 'integer',
    format: 'int64',
    description: 'UTC epoch seconds',
    nullable: true,
  })
  checkedAt!: number | null;
}

@ApiSchema({ name: 'OutgoingTransfer' })
export class OutgoingTransfer {
  @ApiProperty({ type: 'string', enum: CURRENCY_CODES })
  currency!: Currency;
  @ApiProperty({ type: 'string', format: 'uuid' })
  receiverId!: string;
  @ApiProperty({ type: 'string' })
  displayName!: string;
  @ApiProperty({
    type: 'string',
    format: 'uri',
    nullable: true,
    description:
      '활성 회원의 최신 카카오 프로필 이미지 URL. 탈퇴했거나 이미지가 없으면 null.',
  })
  profileImageUrl!: string | null;
  @ApiProperty({
    type: 'string',
    pattern: '^\\d+$',
    description:
      '통화 최소 단위의 정확한 정수 문자열. KRW·JPY·VND는 주 단위, 나머지 지원 통화는 주 단위의 1/100.',
  })
  amountMinor!: string;
  @ApiPropertyOptional({ type: () => CurrentBankAccount })
  account?: CurrentBankAccount;
}

@ApiSchema({ name: 'IncomingTransfer' })
export class IncomingTransfer {
  @ApiProperty({ type: 'string', enum: CURRENCY_CODES })
  currency!: Currency;
  @ApiProperty({ type: 'string', format: 'uuid' })
  senderId!: string;
  @ApiProperty({ type: 'string' })
  displayName!: string;
  @ApiProperty({
    type: 'string',
    format: 'uri',
    nullable: true,
    description:
      '활성 회원의 최신 카카오 프로필 이미지 URL. 탈퇴했거나 이미지가 없으면 null.',
  })
  profileImageUrl!: string | null;
  @ApiProperty({
    type: 'string',
    pattern: '^\\d+$',
    description:
      '통화 최소 단위의 정확한 정수 문자열. KRW·JPY·VND는 주 단위, 나머지 지원 통화는 주 단위의 1/100.',
  })
  amountMinor!: string;
  @ApiProperty({
    type: 'integer',
    format: 'int64',
    description: 'UTC epoch seconds',
    nullable: true,
  })
  receivedAt!: number | null;
}

@ApiSchema({ name: 'Settlement' })
export class SettlementDTO {
  @ApiProperty({ type: 'string', format: 'uuid' })
  roundId!: string;
  @ApiProperty({ type: 'string' })
  name!: string;
  @ApiProperty({ type: 'string' })
  groupName!: string;
  @ApiProperty({ type: 'string', enum: roundStatuses })
  status!: RoundStatus;
  @ApiProperty({ type: 'integer', minimum: 1 })
  version!: number;
  @ApiProperty({
    type: 'boolean',
    description: '조회 사용자가 이 회차의 생성자인지 여부',
  })
  isCreator!: boolean;
  @ApiProperty({ type: 'boolean' })
  finalized!: boolean;
  @ApiProperty({
    type: [CurrencyBalance],
    maxItems: 5,
    description: '최종 통화별 부담액 − 결제액. 최종 저장 전에는 빈 배열.',
  })
  balances!: CurrencyBalance[];
  @ApiProperty({
    type: 'integer',
    format: 'int64',
    description: 'UTC epoch seconds',
    nullable: true,
  })
  checkedAt!: number | null;
  @ApiProperty({
    type: 'boolean',
    description: '조회 사용자가 한 건 이상 수취하는지 여부',
  })
  checkRequired!: boolean;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: '모든 수취 건을 확인한 수취인 수',
  })
  checkedCount!: number;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: '한 건 이상 수취하는 사용자 수',
  })
  requiredCount!: number;
  @ApiProperty({
    type: 'boolean',
    description: '모든 송금 건의 수취 확인 여부. 송금 건이 없으면 true.',
  })
  allChecked!: boolean;
  @ApiProperty({
    type: [SettlementConfirmation],
    description:
      '수취인별 이름 스냅샷, 활성 카카오 프로필, 전체 수취 완료 시각. 한 건이라도 미확인이면 checkedAt은 null입니다.',
  })
  confirmations!: SettlementConfirmation[];
  @ApiProperty({
    type: [OutgoingTransfer],
    description:
      '조회 사용자가 아직 보내야 하는 미확인 송금. 수취 확인 시 제외되고 확인 해제 시 복원됩니다.',
  })
  outgoing!: OutgoingTransfer[];
  @ApiProperty({ type: [IncomingTransfer] })
  incoming!: IncomingTransfer[];
  @ApiProperty({
    type: 'string',
    nullable: true,
    example: '/settlements/00000000-0000-4000-8000-000000000001',
    description:
      '최종 저장 후 제공하며 이전에는 null. 로그인한 본인의 안내를 조회하는 경로이며 초대 링크가 아님.',
  })
  sharePath!: string | null;
}

export type UnfinishedUserRound = {
  id: string;
  name: string;
  status: RoundStatus;
  groupId: string;
  groupName: string;
};
export type {
  CreateRoundRequestDTO,
  VersionRequestDTO,
  ExpenseRequestDTO,
  SettlementCheckRequestDTO,
} from '../req/settle.request.dto';
