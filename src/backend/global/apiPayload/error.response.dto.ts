import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';

@ApiSchema({ name: 'ApiError' })
export class ApiErrorResponseDTO {
  @ApiProperty({
    type: 'string',
    example: 'stale_round',
    description:
      'invalid_input, invalid_amount, custom_share_total_mismatch, expense_amount_limit_exceeded, round_total_limit_exceeded, round_currency_limit_exceeded, invalid_participants, unsupported_currency, unauthorized, forbidden, onboarding_required, not_found, stale_round, invalid_round_state, idempotency_conflict, empty_expenses, pending_settlement_checks, member_exclusion_blocked, minimum_participants, group_member_limit_exceeded, unfinished_rounds, unfinished_group_rounds, unsupported_receipt_type, receipt_too_large, receipt_pending, rate_limited, storage_unavailable 등',
  })
  error!: string;

  @ApiProperty()
  message!: string;

  @ApiPropertyOptional({ description: '공통 예외에서 error와 같은 enum 코드' })
  code?: string;

  @ApiPropertyOptional({
    type: Object,
    nullable: true,
    additionalProperties: true,
  })
  detail?: unknown;

  @ApiPropertyOptional({
    type: Object,
    additionalProperties: true,
    description:
      '현재 버전, 제외 차단 관련 지출 또는 탈퇴를 막는 회차 등. 계좌·인증 토큰은 포함하지 않음.',
  })
  details?: unknown;
}
