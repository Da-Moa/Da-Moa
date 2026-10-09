import type { ErrorCode } from '../../../../shared/appError'
export enum HealthErrorCode {
  NOT_FOUND = 'not_found',
}
export const healthErrors = {
  NOT_FOUND: { status: 404, code: HealthErrorCode.NOT_FOUND, message: "요청한 API를 찾을 수 없어요", detail: null },
} satisfies Record<string, ErrorCode>
