import type { ErrorCode } from '../../../../shared/appError'
export enum UserErrorCode {
  FORBIDDEN = 'forbidden',
  BANK_ACCOUNT_CONFLICT = 'bank_account_conflict',
  ALREADY_ONBOARDED = 'already_onboarded',
  REJOIN_CONFIRMATION_REQUIRED = 'rejoin_confirmation_required',
  UNFINISHED_ROUNDS = 'unfinished_rounds',
  UNAUTHORIZED = 'unauthorized',
  SIGN_IN_CONFLICT = 'sign_in_conflict',
}
export const userErrors = {
  FORBIDDEN: { status: 403, code: UserErrorCode.FORBIDDEN, message: "허용되지 않은 요청입니다", detail: null },
  BANK_ACCOUNT_CONFLICT: { status: 409, code: UserErrorCode.BANK_ACCOUNT_CONFLICT, message: "계좌가 변경됐어요. 최신 계좌를 확인하고 다시 입력해 주세요", detail: null },
  ALREADY_ONBOARDED: { status: 409, code: UserErrorCode.ALREADY_ONBOARDED, message: "이미 가입을 완료했습니다", detail: null },
  REJOIN_CONFIRMATION_REQUIRED: { status: 400, code: UserErrorCode.REJOIN_CONFIRMATION_REQUIRED, message: "이전 기록을 유지하여 재가입하는 데 동의해 주세요", detail: null },
  UNFINISHED_ROUNDS: { status: 409, code: UserErrorCode.UNFINISHED_ROUNDS, message: "진행 중인 정산이 있어 탈퇴할 수 없습니다", detail: null },
  UNAUTHORIZED: { status: 401, code: UserErrorCode.UNAUTHORIZED, message: "로그인이 필요합니다", detail: null },
  SIGN_IN_CONFLICT: { status: 409, code: UserErrorCode.SIGN_IN_CONFLICT, message: "같은 계정의 가입이 처리 중이에요. 로그인을 다시 시도해 주세요", detail: null },
} satisfies Record<string, ErrorCode>
