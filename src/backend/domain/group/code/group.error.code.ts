import { MAX_GROUP_MEMBERS } from '../../../../shared/domain/group/constants'
import type { ErrorCode } from '../../../../shared/appError'
export enum GroupErrorCode {
  GROUP_CREATION_KEY_REQUIRED = 'invalid_request_key',
  FORBIDDEN_REQUEST = 'forbidden',
  API_NOT_FOUND = 'not_found',
  RESOURCE_NOT_FOUND = 'not_found',
  GROUP_ALREADY_EXISTS = 'group_already_exists',
  GROUP_ALREADY_MEMBER = 'group_already_member',
  CREATOR_ONLY = 'forbidden',
  UNFINISHED_GROUP_ROUNDS = 'unfinished_group_rounds',
  UNFINISHED_ROUNDS = 'unfinished_rounds',
  UNAUTHORIZED = 'unauthorized',
  MEMBER_LIMIT_EXCEEDED = 'group_member_limit_exceeded',
}
export const groupErrors = {
  GROUP_CREATION_KEY_REQUIRED: { status: 400, code: GroupErrorCode.GROUP_CREATION_KEY_REQUIRED, message: "UUIDv7 모임 생성 키가 필요합니다", detail: null },
  MEMBER_LIMIT_EXCEEDED: { status: 409, code: GroupErrorCode.MEMBER_LIMIT_EXCEEDED, message: `모임은 생성자를 포함해 최대 ${MAX_GROUP_MEMBERS}명까지 참여할 수 있어요`, detail: null },
  FORBIDDEN_REQUEST: { status: 403, code: GroupErrorCode.FORBIDDEN_REQUEST, message: "허용되지 않은 요청입니다", detail: null },
  API_NOT_FOUND: { status: 404, code: GroupErrorCode.API_NOT_FOUND, message: "요청한 API를 찾을 수 없어요", detail: null },
  RESOURCE_NOT_FOUND: { status: 404, code: GroupErrorCode.RESOURCE_NOT_FOUND, message: "요청한 자료를 찾을 수 없어요", detail: null },
  GROUP_ALREADY_EXISTS: { status: 409, code: GroupErrorCode.GROUP_ALREADY_EXISTS, message: "이미 생성된 모임입니다. 모임 목록을 확인해 주세요", detail: null },
  GROUP_ALREADY_MEMBER: { status: 409, code: GroupErrorCode.GROUP_ALREADY_MEMBER, message: "이미 참여 중인 모임입니다", detail: null },
  CREATOR_ONLY: { status: 403, code: GroupErrorCode.CREATOR_ONLY, message: "모임 생성자만 할 수 있어요", detail: null },
  UNFINISHED_GROUP_ROUNDS: { status: 409, code: GroupErrorCode.UNFINISHED_GROUP_ROUNDS, message: "종료되지 않은 회차가 있어 모임을 없앨 수 없어요", detail: null },
  UNFINISHED_ROUNDS: { status: 409, code: GroupErrorCode.UNFINISHED_ROUNDS, message: "참여 중인 회차가 있어 모임에서 나갈 수 없어요", detail: null },
  UNAUTHORIZED: { status: 401, code: GroupErrorCode.UNAUTHORIZED, message: "로그인이 필요합니다", detail: null },
} satisfies Record<string, ErrorCode>
