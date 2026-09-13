import { MAX_GROUP_MEMBERS } from './domain-types'

type Schema = Record<string, unknown>
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: 'object', properties, ...(required.length ? { required } : {}) })
const array = (items: Schema): Schema => ({ type: 'array', items })
const string: Schema = { type: 'string' }
const integer: Schema = { type: 'integer', minimum: 1 }
const id: Schema = { type: 'string', format: 'uuid' }
const minor: Schema = { type: 'string', pattern: '^\\d+$', description: '통화 최소 단위의 정확한 정수 문자열. USD는 센트, KRW·JPY는 원·엔.' }
const currency: Schema = { type: 'string', enum: ['KRW', 'JPY', 'USD'] }
const status: Schema = { type: 'string', enum: ['RECORDING', 'CONFIRMED', 'LOCKED', 'COMPLETED'] }
const timestamp: Schema = { type: 'integer', format: 'int64', description: 'UTC epoch seconds' }
const nullableTimestamp: Schema = { ...timestamp, nullable: true }
const profileImage: Schema = { type: 'string', format: 'uri', nullable: true, description: '활성 회원의 최신 카카오 프로필 이미지 URL. 탈퇴했거나 이미지가 없으면 null.' }
const bankFields = { bankName: { type: 'string', minLength: 1, maxLength: 100 }, accountNumber: { type: 'string', minLength: 1, maxLength: 100, description: '숫자·공백·하이픈 입력. 구분자를 제거한 숫자 1~64자와 선행 0을 보존합니다.' }, accountHolder: { type: 'string', minLength: 1, maxLength: 100 } }
const bankVersion: Schema = { type: 'integer', minimum: 0 }
const bankInputFields = {
  bankCode: { type: 'string', pattern: '^\\d{3}$', description: '지원 금융기관의 표준 코드' },
  accountNumber: { type: 'string', maxLength: 64, description: '숫자·ASCII 공백·하이픈. 정규화 후 숫자 1~16자리, 선행 0 보존.' },
  birthDate: { type: 'string', format: 'date', description: 'YYYY-MM-DD. 금결원 확인 모드에서만 필수이며 확인 전 저장에는 보내지 않습니다. DB에 저장하지 않습니다.' },
  accountHolder: { type: 'string', minLength: 1, maxLength: 100, description: 'NFC·앞뒤 공백 정리 후 1~40자. 계좌실명조회 응답과 정확히 비교합니다.' },
  expectedBankVersion: bankVersion,
  verifyWithOpenBanking: { type: 'boolean', default: true, description: 'false: 금결원 호출 없이 계좌 저장. true 또는 생략: 사용자 동의와 계좌실명조회 후 저장.' },
}
const bankInputRequired = ['bankCode', 'accountNumber', 'accountHolder', 'expectedBankVersion']
const bankVerificationModes = { oneOf: [
  { properties: { verifyWithOpenBanking: { enum: [false] } }, required: ['verifyWithOpenBanking'], not: { required: ['birthDate'] } },
  { properties: { verifyWithOpenBanking: { enum: [true] } }, required: ['birthDate'] },
] }
const openBankingFields = { status: { type: 'string', enum: ['NOT_CONNECTED', 'CONNECTED', 'REAUTH_REQUIRED', 'DISCONNECT_PENDING', 'DISCONNECTED'] }, authenticatedAt: nullableTimestamp, environment: { type: 'string', enum: ['test', 'production'] } }
const versionBody = object({ expectedVersion: integer }, ['expectedVersion'])
const settlementCheckBody = object({ expectedVersion: integer, checked: { type: 'boolean' }, senderId: { ...id, description: '생략하면 본인의 모든 수취 건, 지정하면 해당 송금자의 한 건만 변경합니다.' } }, ['expectedVersion', 'checked'])
const expenseFields = {
  description: string,
  amount: { type: 'string', pattern: '^\\d+(\\.\\d{1,2})?$', description: '양의 십진 문자열. KRW·JPY는 정수, USD는 소수 최대 2자리. 통화의 주 단위 기준 지출 한 건 최대 100,000,000. 숫자·지수표기·쉼표·환불 금액은 거부.' },
  payerId: id,
  splitMode: { type: 'string', enum: ['ALL', 'SELECTED'] },
  participantIds: { type: 'array', items: id, minItems: 1, uniqueItems: true, description: 'SELECTED일 때 필수. ALL은 서버가 회차의 제외되지 않은 전원으로 결정.' },
  expectedVersion: integer,
}
const pageParameters = [
  { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, minimum: 1, maximum: 100 } },
  { name: 'cursor', in: 'query', schema: string, description: '(created_at, id)에 기반한 서버 발급 커서' },
]
const roundSearchParameter = { name: 'q', in: 'query', schema: { type: 'string', minLength: 1, maxLength: 100 }, description: '모임명 또는 회차명의 대소문자를 구분하지 않는 부분 검색어' }
const mutationParameters = [
  { name: 'Origin', in: 'header', required: true, schema: { type: 'string', format: 'uri' }, description: '현재 서비스 origin과 정확히 일치해야 합니다.' },
  { name: 'Idempotency-Key', in: 'header', required: true, schema: id, description: '한 제출당 한 UUID. 네트워크·세션 갱신 후 재시도에도 같은 키와 본문을 사용합니다.' },
]
const domainResponses = {
  DomainFailure: {
    description: '요청 오류. 409는 상태·버전·제외·인원 제한·미종료 회차·멱등 키 충돌, 424 openbanking_test_data_missing은 금융결제원 계좌실명조회 테스트 응답 미등록·불일치, 503은 같은 키로 재시도할 저장소·외부 서비스 오류입니다.',
    content: { 'application/json': { schema: ref('ApiError') } },
  },
}
const groupFields = { id, creatorId: { ...id, description: '모임 생성자 ID. 초대와 모임 관리를 담당합니다.' }, name: string, createdAt: timestamp }
const roundFields = {
  id, groupId: id, groupName: string, name: string, currency, status, version: integer, createdAt: timestamp,
  finalizedAt: nullableTimestamp, completedAt: nullableTimestamp, balanceMinor: { type: 'string', pattern: '^-?\\d+$', nullable: true },
  totalMinor: minor, memberCount: { type: 'integer', minimum: 0 },
}
const domainSchemas = {
  Currency: currency,
  RoundStatus: status,
  MinorAmount: minor,
  ApiError: object({
    error: { type: 'string', example: 'stale_round', description: 'invalid_input, invalid_amount, expense_amount_limit_exceeded, round_total_limit_exceeded, invalid_participants, unsupported_currency, unauthorized, forbidden, onboarding_required, not_found, stale_round, invalid_round_state, idempotency_conflict, empty_expenses, pending_settlement_checks, member_exclusion_blocked, minimum_participants, group_member_limit_exceeded, unfinished_rounds, unfinished_group_rounds, unsupported_receipt_type, storage_unavailable 등' },
    message: string,
    details: { type: 'object', additionalProperties: true, description: '현재 버전, 제외 차단 관련 지출 또는 탈퇴를 막는 회차 등. 계좌·인증 토큰은 포함하지 않음.' },
  }, ['error', 'message']),
  BankAccount: { ...object(bankInputFields, bankInputRequired), ...bankVerificationModes, additionalProperties: false },
  RegisteredBankAccount: object({ fintechUseNum: { type: 'string', pattern: '^\\d{24}$', description: '등록계좌 선택용 식별자. 대표 계좌 저장 요청에는 사용하지 않습니다.' }, bankCode: bankInputFields.bankCode, bankName: string, accountHolder: string,
    accountNumber: { type: 'string', nullable: true, pattern: '^\\d{1,16}$', description: '금융결제원이 전체 번호를 제공한 경우에만 값이 있습니다. 미제공 시 null.' }, accountNumberMasked: string }, ['fintechUseNum', 'bankCode', 'bankName', 'accountHolder', 'accountNumber', 'accountNumberMasked']),
  CurrentBankAccount: object({ bankName: { type: 'string', nullable: true }, accountNumber: { type: 'string', nullable: true }, accountHolder: { type: 'string', nullable: true }, verifiedAt: { ...nullableTimestamp, description: 'null이면 계좌번호와 함께 “확인되지 않은 계좌입니다.”를 표시합니다.' } }, ['bankName', 'accountNumber', 'accountHolder', 'verifiedAt']),
  Me: object({ id, displayName: { type: 'string', nullable: true }, email: { type: 'string', nullable: true }, profileImageUrl: profileImage, purpose: { type: 'string', enum: ['app', 'onboarding'] }, deletedAt: nullableTimestamp, onboardingCompletedAt: nullableTimestamp, bankVersion, openBanking: object(openBankingFields, Object.keys(openBankingFields)), bankAccount: { type: 'object', nullable: true, properties: { ...bankFields, bankCode: { type: 'string', nullable: true }, verifiedAt: nullableTimestamp }, description: '본인의 현재 대표 계좌. verifiedAt=null이면 “확인되지 않은 계좌입니다.”를 표시합니다. 수동 저장·기존 계좌 모두 해당하며 OAuth 연결만으로 확인 상태가 되지 않습니다. 확인 이력은 실제 이체 성공을 보장하지 않습니다.' } }, ['id', 'displayName', 'email', 'profileImageUrl', 'purpose', 'deletedAt', 'onboardingCompletedAt', 'bankAccount', 'bankVersion', 'openBanking']),
  Group: object(groupFields, Object.keys(groupFields)),
  GroupMember: object({ userId: id, displayName: string, excludedAt: nullableTimestamp }, ['userId', 'displayName', 'excludedAt']),
  GroupDetail: object({ ...groupFields, members: { ...array(ref('GroupMember')), maxItems: MAX_GROUP_MEMBERS, description: '생성자를 포함해 최대 10명이며 생성자가 첫 번째입니다.' }, isCreator: { type: 'boolean', description: '조회 사용자가 현재 활성 모임 생성자인지 여부' }, invites: array(object({ id, expiresAt: timestamp }, ['id', 'expiresAt'])) }, [...Object.keys(groupFields), 'members', 'isCreator', 'invites']),
  Round: object(roundFields, Object.keys(roundFields)),
  RoundMember: object({ userId: id, displayName: string, profileImageUrl: profileImage, excludedAt: nullableTimestamp }, ['userId', 'displayName', 'profileImageUrl', 'excludedAt']),
  Expense: object({ id, authorId: id, payerId: id, description: string, amountMinor: minor, splitMode: expenseFields.splitMode, participantIds: array(id), baseShareMinor: { ...minor, nullable: true }, remainderUnits: { type: 'integer', minimum: 0, nullable: true }, shares: array(object({ userId: id, amountMinor: { ...minor, nullable: true }, receivedRemainder: { type: 'boolean', nullable: true } }, ['userId', 'amountMinor', 'receivedRemainder'])), receipts: array(ref('Receipt')), createdAt: timestamp, updatedAt: timestamp }, ['id', 'authorId', 'payerId', 'description', 'amountMinor', 'splitMode', 'participantIds', 'baseShareMinor', 'remainderUnits', 'shares', 'receipts', 'createdAt', 'updatedAt']),
  Receipt: object({ id, mimeType: { type: 'string', enum: ['image/avif', 'image/jpeg', 'image/png', 'image/webp'], description: '신규 업로드는 image/avif이며 나머지는 기존 저장 자료 조회 호환 값입니다.' }, byteSize: { type: 'integer', minimum: 1, description: '변환 후 저장된 이미지의 바이트 크기입니다. 앱 자체 상한은 없습니다.' } }, ['id', 'mimeType', 'byteSize']),
  SettlementTransfer: object({ senderId: id, receiverId: id, amountMinor: minor }, ['senderId', 'receiverId', 'amountMinor']),
  RoundDetail: object({ ...roundFields, creatorId: { ...id, description: '회차 생성자 ID. 해당 회차 수명주기와 전체 지출을 관리합니다.' }, groupCreatorId: { ...id, description: '소속 모임 생성자 ID. 회차 생성자와 다를 수 있습니다.' }, isCreator: { type: 'boolean', description: '조회 사용자가 이 회차의 생성자인지 여부' }, members: array(ref('RoundMember')), expenses: array(ref('Expense')), expensesNextCursor: { type: 'string', nullable: true }, transfers: { ...array(ref('SettlementTransfer')), description: '조회 사용자가 보내거나 받는 송금 관계만 포함합니다.' }, pendingRemainderMinor: { ...minor, description: '최종 추첨 전 누구에게도 배정하지 않은 통화 최소 단위 금액의 합. 최종화 후 0.' } }, [...Object.keys(roundFields), 'creatorId', 'groupCreatorId', 'isCreator', 'members', 'expenses', 'expensesNextCursor', 'transfers', 'pendingRemainderMinor']),
  MutationResult: object({ id, roundId: id, status, version: integer, inviteId: id, linkUnavailable: { type: 'boolean' }, sharePath: { type: 'string', description: '초대 최초 발급에서만 /invites/{token} 경로를 반환하며 재시도 기록에는 저장하지 않음' } }, ['id']),
  ExclusionCheck: object({ allowed: { type: 'boolean' }, reason: { type: 'string', nullable: true }, expenses: array(object({ id, description: string, amountMinor: minor, authorId: id, authorName: string, reason: string }, ['id', 'description', 'amountMinor', 'authorId', 'authorName', 'reason'])) }, ['allowed', 'reason', 'expenses']),
  OutgoingTransfer: object({ receiverId: id, displayName: string, profileImageUrl: profileImage, amountMinor: minor, account: ref('CurrentBankAccount') }, ['receiverId', 'displayName', 'profileImageUrl', 'amountMinor']),
  IncomingTransfer: object({ senderId: id, displayName: string, profileImageUrl: profileImage, amountMinor: minor, receivedAt: nullableTimestamp }, ['senderId', 'displayName', 'profileImageUrl', 'amountMinor', 'receivedAt']),
  SettlementConfirmation: object({ userId: id, displayName: string, profileImageUrl: profileImage, checkedAt: nullableTimestamp }, ['userId', 'displayName', 'profileImageUrl', 'checkedAt']),
  Settlement: object({ roundId: id, name: string, groupName: string, status, version: integer, isCreator: { type: 'boolean', description: '조회 사용자가 이 회차의 생성자인지 여부' }, finalized: { type: 'boolean' }, currency, balanceMinor: { type: 'string', pattern: '^-?\\d+$', nullable: true, description: '부담액 − 결제액. 양수는 보낼 돈, 음수는 받을 돈. 최종 저장 전에는 null.' }, checkedAt: nullableTimestamp, checkRequired: { type: 'boolean', description: '조회 사용자가 한 건 이상 수취하는지 여부' }, checkedCount: { type: 'integer', minimum: 0, description: '모든 수취 건을 확인한 수취인 수' }, requiredCount: { type: 'integer', minimum: 0, description: '한 건 이상 수취하는 사용자 수' }, allChecked: { type: 'boolean', description: '모든 송금 건의 수취 확인 여부. 송금 건이 없으면 true.' }, confirmations: { ...array(ref('SettlementConfirmation')), description: '수취인별 이름 스냅샷, 활성 카카오 프로필, 전체 수취 완료 시각. 한 건이라도 미확인이면 checkedAt은 null입니다.' }, outgoing: { ...array(ref('OutgoingTransfer')), description: '조회 사용자가 아직 보내야 하는 미확인 송금. 수취 확인 시 제외되고 확인 해제 시 복원됩니다.' }, incoming: array(ref('IncomingTransfer')), sharePath: { type: 'string', nullable: true, example: '/settlements/00000000-0000-4000-8000-000000000001', description: '최종 저장 후 제공하며 이전에는 null. 로그인한 본인의 안내를 조회하는 경로이며 초대 링크가 아님.' } }, ['roundId', 'name', 'groupName', 'status', 'version', 'isCreator', 'finalized', 'currency', 'balanceMinor', 'checkedAt', 'checkRequired', 'checkedCount', 'requiredCount', 'allChecked', 'confirmations', 'outgoing', 'incoming', 'sharePath']),
  GroupPage: object({ items: array(ref('Group')), nextCursor: { type: 'string', nullable: true } }, ['items', 'nextCursor']),
  RoundPage: object({ items: array(ref('Round')), nextCursor: { type: 'string', nullable: true } }, ['items', 'nextCursor']),
}

type OperationOptions = {
  request?: Schema
  response?: Schema
  mutation?: boolean
  parameters?: Schema[]
  description?: string
  multipart?: boolean
}
function operation(tag: string, summary: string, options: OperationOptions = {}) {
  return {
    tags: [tag], summary,
    description: options.description ?? '활성 계정·세션 및 리소스 권한을 서버에서 검증합니다. 응답은 private, no-store입니다.',
    security: [{ accessCookie: [] }],
    parameters: [...(options.mutation ? mutationParameters : []), ...(options.parameters ?? [])],
    ...(options.request ? { requestBody: { required: true, content: { [options.multipart ? 'multipart/form-data' : 'application/json']: { schema: options.request } } } } : {}),
    responses: {
      '200': { description: '요청 성공', content: { 'application/json': { schema: object({ data: options.response ?? ref('MutationResult') }, ['data']) } } },
      ...Object.fromEntries(['400', '401', '403', '404', '409', '422', '424', '429', '503', ...(options.multipart ? ['415'] : [])].map(code => [code, { $ref: '#/components/responses/DomainFailure' }])),
    },
  }
}
const roundCommand = (summary: string, description: string) => operation('정산', summary, { mutation: true, request: versionBody, description })
const domainPaths = {
  '/api/me': { get: operation('계정', '본인 프로필·가입 상태·계좌 조회', { response: ref('Me'), description: 'app 또는 onboarding 목적의 활성 세션으로 본인 데이터만 조회합니다. 일반 기능은 가입 완료 app 세션이 필요합니다.' }) },
  '/api/me/openbanking': { post: operation('계정', '금융결제원 사용자 인증 시작 또는 기존 연결 재사용', { parameters: [mutationParameters[0]], request: { ...object({ context: { type: 'string', enum: ['onboarding', 'settings'] }, returnTo: string }, ['context']), additionalProperties: false }, response: { oneOf: [object({ authorizationUrl: { type: 'string', format: 'uri' } }, ['authorizationUrl']), object({ returnTo: string }, ['returnTo'])] }, description: 'app/onboarding 세션과 시작 목적을 검사합니다. 유효한 기존 연결은 재사용하고, 이전 탈퇴 해제 대기 중에는 새 인증을 막습니다.' }) },
  '/api/me/openbanking/accounts': { get: operation('계정', '본인의 등록계좌 조회 및 자동 입력', { response: object({ accounts: array(ref('RegisteredBankAccount')) }, ['accounts']), description: 'app/onboarding 세션의 사용자 토큰으로 본인의 활성·조회 동의·개인 계좌 중 지원 은행만 조회합니다. 조회 후 세션·연결 버전과 상태를 재검사합니다. 은행·예금주와 제공 가능한 전체 번호를 자동 입력에 사용하며, 번호 미제공 시 직접 입력합니다. 목록 선택만으로 실명조회 검증을 생략하지 않습니다. private, no-store 응답이며 사용자 ID·계좌번호를 쿼리로 받지 않습니다.' }) },
  '/api/me/onboarding': { post: operation('계정', '계좌 저장 후 가입·명시적 재가입 완료', { response: object({ id, returnTo: string }, ['id', 'returnTo']), request: { ...object({ ...bankInputFields, confirmRejoin: { type: 'boolean', description: '탈퇴 계정의 명시적 재가입 동의' } }, bankInputRequired), ...bankVerificationModes, additionalProperties: false }, parameters: [mutationParameters[0]], description: 'verifyWithOpenBanking=false이면 금결원 동의·생년월일 없이 계좌를 확인 전 상태로 저장하고 가입을 완료합니다. true 또는 생략이면 사용자 인증과 기관 계좌실명조회·예금주 일치가 필요합니다. 계좌·가입·새 app 세션을 원자적으로 저장하며 이전 탈퇴 해제 대기 중 재가입을 막고 기존 모임·관리 권한은 복구하지 않습니다. 쿠키 응답 유실은 카카오 재로그인으로 복구합니다.' }) },
  '/api/me/bank-account': { put: operation('계정', '대표 계좌 저장 또는 금결원 계좌 확인', { mutation: true, request: ref('BankAccount'), response: object({ id, bankVersion }, ['id', 'bankVersion']), description: 'verifyWithOpenBanking=false이면 외부 호출 없이 저장하며 계좌가 바뀌면 검증 이력을 초기화합니다. true 또는 생략이면 실명조회 후 버전·회원·연결을 재검사합니다. 기존 금결원 연결은 유지하며 진행 중 정산도 교체를 막지 않습니다. 검증 실패는 자동으로 미확인 저장하지 않으며, 같은 성공 멱등 키는 외부 재조회 없이 반환합니다.' }) },
  '/api/groups': {
    get: operation('모임', '활성 모임 목록', { response: ref('GroupPage'), parameters: pageParameters }),
    post: operation('모임', '모임 생성', { mutation: true, request: { ...object({ name: string }, ['name']), additionalProperties: false } }),
  },
  '/api/groups/{groupId}': {
    get: operation('모임', '현재 모임과 활성 멤버 후보', { response: ref('GroupDetail') }),
    delete: operation('모임', '모임 나가기 또는 없애기', { mutation: true, description: '일반 참여자는 본인이 참여 중인 미종료 회차가 없을 때 현재 멤버십의 leftAt을 기록하고 나갑니다. 모임 생성자는 본인 참여 여부와 무관하게 모임 전체의 모든 회차가 종료된 경우에만 모든 멤버십을 종료하고 초대를 폐기합니다. 완료된 회차와 모임 이름은 과거 정산 조회를 위해 보존합니다.' }),
  },
  '/api/groups/{groupId}/rounds': {
    get: operation('모임', '본인 참여 권한이 있는 모임 회차 목록', { response: ref('RoundPage'), parameters: [...pageParameters, roundSearchParameter] }),
    post: operation('모임', '선택한 멤버로 기록 시작', { mutation: true, request: { ...object({ name: string, currency, participantIds: { type: 'array', items: id, minItems: 2, maxItems: MAX_GROUP_MEMBERS, uniqueItems: true, description: '현재 활성 모임 멤버 중 요청자 자신을 반드시 포함합니다.' } }, ['name', 'currency', 'participantIds']), additionalProperties: false }, description: '모든 활성 모임 참여자가 요청자 자신을 포함한 최소 2명과 USD·KRW·JPY 중 통화를 선택해 회차를 만들 수 있습니다. 요청자가 회차 생성자가 되어 해당 회차 수명주기와 전체 지출을 관리하며, 모임 생성자는 필수 참여자가 아닙니다. currency는 필수이고 같은 모임에서도 회차마다 다른 통화를 선택할 수 있습니다. 생성 후 통화는 변경할 수 없고 과거 회차의 통화는 보존합니다. 미완료 회차가 있어도 생성할 수 있습니다.' }),
  },
  '/api/groups/{groupId}/invites': { post: operation('모임', '7일 유효 초대 발급·재발급', { mutation: true, request: object({ replaceInviteId: id }), description: '모임 생성자가 발급하며 원문 링크는 최초 응답에서만 제공합니다. 같은 키 재시도는 inviteId와 linkUnavailable을 반환합니다. 새 키와 replaceInviteId로 이전 초대를 폐기하며 다시 발급합니다.' }) },
  '/api/groups/{groupId}/invites/{inviteId}': { delete: operation('모임', '모임 생성자가 초대 폐기', { mutation: true }) },
  '/api/invites/{token}': { get: operation('모임', '인증 후 초대 모임 미리보기', { response: object({ groupId: id, groupName: string, isMember: { type: 'boolean' }, expiresAt: timestamp }, ['groupId', 'groupName', 'isMember', 'expiresAt']), description: '조회만으로 멤버십을 생성하지 않습니다. 만료·폐기되었거나 활성 모임 생성자가 없는 초대는 거부합니다.' }) },
  '/api/invites/{token}/accept': { post: operation('모임', '초대를 명시적으로 수락', { mutation: true, description: '생성자를 포함한 활성 멤버는 최대 10명입니다. 10명인 모임의 새 참여와 이탈한 사용자의 재참여는 409 group_member_limit_exceeded로 거부하지만 활성 멤버의 중복 수락은 같은 결과입니다. 기존 회차에는 자동 추가되지 않습니다.' }) },
  '/api/rounds': { get: operation('정산', '본인 참여 이력으로 회차 목록 조회', { response: ref('RoundPage'), parameters: [...pageParameters, roundSearchParameter, { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'RECORDING', 'CONFIRMED', 'LOCKED', 'COMPLETED'] } }], description: '현재 모임 멤버십과 무관하게 본인 참여 이력이 있는 회차를 조회합니다. 다른 회차·통화 금액을 합산하지 않습니다.' }) },
  '/api/rounds/{roundId}': {
    get: operation('정산', '회차·지출·참여 내역 조회', { response: ref('RoundDetail'), parameters: pageParameters, description: 'creatorId는 회차 생성자, groupCreatorId는 모임 생성자이며 isCreator는 조회 사용자가 회차 생성자인지를 뜻합니다. 같은 DB 스냅샷의 원본과 버전을 반환합니다. 회차 참여자의 이름과 활성 회원의 최신 카카오 프로필 이미지를 반환하며 탈퇴자의 이미지는 null입니다. 최종화 전에는 각 지출의 균등 기본 몫만 회차 전체에서 상계한 예상 송금 관계와 미배분 나머지 금액을, 최종화 뒤에는 저장된 최종 관계를 반환합니다. 송금 관계는 조회 사용자가 보내거나 받는 행만 포함하며 계좌정보는 반환하지 않습니다.' }),
    delete: roundCommand('기록 단계 회차 전체 취소', '회차 생성자만 현재 RECORDING 회차를 취소합니다. 회차·지출·분담·증빙을 하드 삭제합니다. 재오픈 후 취소도 가능하며 같은 키 재시도는 기존 성공 결과를 반환합니다.'),
  },
  '/api/rounds/{roundId}/expenses': { post: operation('지출', '지출 생성', { mutation: true, request: object(expenseFields, ['description', 'amount', 'payerId', 'splitMode', 'expectedVersion']), description: '기록 단계의 제외되지 않은 참여자가 작성합니다. 결제자 한 명과 전체 또는 선택 부담자를 지정하며 작성자는 로그인 사용자로 저장합니다. 통화 주 단위 기준 한 건은 100,000,000 이하, 회차 누적은 1,000,000,000 이하만 허용합니다.' }) },
  '/api/rounds/{roundId}/expenses/{expenseId}': {
    patch: operation('지출', '지출 수정', { mutation: true, request: object(expenseFields, ['expectedVersion']), description: '기록 단계에서 제외되지 않은 원작성자 또는 해당 회차 생성자만 수정합니다. 모임 생성자라는 이유만으로 수정할 수 없으며 작성자·회차·통화는 변경할 수 없습니다. 수정 금액으로 기존 금액을 대체해 한 건 100,000,000·회차 누적 1,000,000,000 한도를 다시 검증합니다. 기존 제외된 비부담 결제자의 관계는 보존할 수 있습니다.' }),
    delete: operation('지출', '지출·분담·증빙 삭제', { mutation: true, request: versionBody, description: '기록 단계에서 제외되지 않은 원작성자 또는 해당 회차 생성자만 지출과 연결 자료를 삭제합니다. 모임 생성자라는 이유만으로 삭제할 수 없습니다.' }),
  },
  '/api/rounds/{roundId}/expenses/{expenseId}/receipts': { post: operation('지출', '영수증 증빙 이미지 업로드', { mutation: true, multipart: true, request: object({ file: { type: 'string', format: 'binary', description: '실제 JPEG·PNG·WebP 바이트. 앱 자체 파일 크기 상한은 없으며 OCR을 수행하지 않습니다.' }, expectedVersion: integer }, ['file', 'expectedVersion']), description: '기록 단계에서 제외되지 않은 지출 원작성자 또는 해당 회차 생성자가 이미 저장된 지출에 파일 하나를 별도로 업로드합니다. 실제 입력 포맷을 검증하고 픽셀 수 안전장치 안에서 AVIF로 변환해 저장합니다. 업로드 실패는 지출 원본을 삭제하지 않으며 목록 응답에는 바이트 본문이 없습니다. Vercel Function의 요청·응답별 4.5 MB 상한은 별도의 배포 인프라 제약입니다.' }) },
  '/api/rounds/{roundId}/expenses/{expenseId}/receipts/{receiptId}': { delete: operation('지출', '영수증 증빙 삭제', { mutation: true, request: versionBody, description: '기록 단계에서 제외되지 않은 지출 원작성자 또는 해당 회차 생성자만 증빙을 삭제합니다.' }) },
  '/api/receipts/{receiptId}': { get: { ...operation('지출', '참여 이력 검증 후 영수증 이미지 조회'), responses: { '200': { description: '신규 업로드는 AVIF, 기존 자료는 저장된 JPEG·PNG·WebP로 응답합니다. private, no-store 및 nosniff 헤더를 적용합니다.', content: Object.fromEntries(['image/avif', 'image/jpeg', 'image/png', 'image/webp'].map(mime => [mime, { schema: { type: 'string', format: 'binary' } }])) }, '401': { $ref: '#/components/responses/DomainFailure' }, '404': { $ref: '#/components/responses/DomainFailure' }, '503': { $ref: '#/components/responses/DomainFailure' } } } },
  '/api/rounds/{roundId}/members/{userId}/exclusion-check': { get: operation('정산', '회차 사용자 제외 가능 여부와 관련 지출 확인', { response: ref('ExclusionCheck'), description: '회차 생성자만 조회합니다. 본인은 제외할 수 없고 모임 생성자는 다른 참여자와 같은 조건으로 검사합니다. 결제자 겸 부담자·SELECTED 부담자·최소 인원 위반을 확인하고 관련 지출 전체를 반환합니다. 이 검사는 데이터를 변경하지 않습니다.' }) },
  '/api/rounds/{roundId}/members/{userId}/exclude': { post: roundCommand('회차 사용자 제외와 ALL 재분배', '회차 생성자만 기록 단계에서 제외 조건을 다시 검사합니다. 본인은 제외할 수 없고 모임 생성자는 다른 참여자와 같은 조건으로 제외할 수 있습니다. 차단 시 해당 사용자와 연관된 정산이 있습니다. 메시지와 관련 내역을 반환하며 아무것도 변경하지 않습니다. 성공 시 round_members.excluded_at과 해당 회차의 ALL 분배만 수정합니다. group_members.left_at, 다른 회차, 다음 회차 후보와 비부담 결제자 수취 관계는 보존합니다.') },
  '/api/rounds/{roundId}/confirm': { post: roundCommand('정산 확정', '회차 생성자가 RECORDING 회차의 모든 지출을 재검증하고 기본 몫·나머지를 저장합니다. 지출 0건이면 409 empty_expenses와 지출 내역이 없습니다 메시지를 반환합니다. 이 단계에서는 추첨하지 않습니다.') },
  '/api/rounds/{roundId}/reopen': { post: roundCommand('확정 회차를 기록 단계로 재오픈', '회차 생성자만 미전송·미종료 CONFIRMED 회차를 RECORDING으로 되돌립니다. 계산값은 지우고 지출 원본·증빙은 유지합니다. 이후 수정 → 확정 흐름을 다시 따릅니다.') },
  '/api/rounds/{roundId}/send': { post: roundCommand('전송을 확인하고 회차 잠금', '회차 생성자가 CONFIRMED 회차를 LOCKED로 전환합니다. 실제 메시지를 전송하지 않습니다. 원본·참여자 수정과 재오픈·취소는 이후 불가합니다. 나머지가 없으면 결과를 함께 저장하고, 있으면 추첨 전 최종 안내·링크를 제공하지 않습니다.') },
  '/api/rounds/{roundId}/draw': { post: roundCommand('잠긴 회차의 나머지를 한 번 추첨', '회차 생성자가 서버 난수로 각 지출의 서로 다른 부담자에게 최소 단위 1을 배분합니다. 모든 최종 분담·잔액·송금·finalizedAt을 한 트랜잭션에 저장합니다. 이미 저장했다면 다른 키여도 다시 추첨하지 않습니다.') },
  '/api/rounds/{roundId}/complete': { post: roundCommand('모든 송금 수취 확인 후 정산 종료', '회차 생성자만 최종 금액이 저장된 LOCKED 회차에서 모든 송금 건의 수취가 확인된 경우 COMPLETED로 바꿉니다. 송금 건이 없으면 별도 확인 없이 종료할 수 있습니다. 완료 데이터는 누구도 수정할 수 없고 해당 회차의 탈퇴 차단을 해제합니다.') },
  '/api/rounds/{roundId}/force-complete': { post: roundCommand('정산 강제 종료', '회차 생성자만 최종 금액이 저장된 LOCKED 회차를 수취 확인과 무관하게 COMPLETED로 바꿉니다. 미확인 송금 건은 null로 보존하며 완료 후 누구도 확인이나 정산 데이터를 변경할 수 없습니다.') },
  '/api/rounds/{roundId}/settlement-check': { post: operation('정산', '본인의 송금 건별 수취 확인 설정', { mutation: true, request: settlementCheckBody, description: '최종 금액이 저장된 LOCKED 회차에서 수취인 본인만 확인을 설정하거나 해제합니다. senderId를 지정하면 해당 송금 건만, 생략하면 본인의 모든 수취 건을 변경합니다. 확인 변경은 회차 version을 올리지 않아 같은 수취인의 여러 건을 동시에 저장할 수 있습니다. 완료 후에는 변경할 수 없습니다.' }) },
  '/api/rounds/{roundId}/settlement': { get: operation('정산', '본인의 개인 지급·수취 안내', { response: ref('Settlement'), description: '최종 저장 전에는 대기 상태만 반환합니다. 최종 금액은 고정하며 KRW에서는 본인이 지급할 수취인의 최신 계좌만 조회합니다. 지급·수취 상대의 이름과 활성 회원의 최신 카카오 프로필 이미지를 반환하고 탈퇴자의 이미지는 null로 반환합니다. 각 수취 건의 확인 시각과 수취인별 전체 완료 상태를 반환하며, 강제 종료 뒤에도 미확인 건은 null로 보존합니다. USD·JPY와 수취 내역에는 계좌 필드가 없습니다. 모임·회차 생성자도 같은 공개 범위이며 링크는 로그인한 본인의 정보만 보여 줍니다.' }) },
}
const documentedDomainPaths = Object.fromEntries(Object.entries(domainPaths).map(([path, operations]) => [path, {
  parameters: [...path.matchAll(/\{([^}]+)\}/g)].map(([, name]) => ({ name, in: 'path', required: true, schema: name === 'token' ? string : id })),
  ...operations,
}]))

export const openApiDocument = {
  // ponytail: keep Swagger UI on its Turbopack-safe resolver; use a static bundle before adopting OpenAPI 3.1-only schemas.
  openapi: '3.0.3',
  info: {
    title: '다모아 API',
    version: '2.0.0',
    description: '카카오 인증·계좌·모임·회차·증빙·개인 정산 API. HttpOnly 쿠키로 인증하며 변경은 origin·권한·멱등 키를 검증합니다. 금액은 정확한 문자열이고 양수 잔액은 보낼 돈, 음수는 받을 돈입니다.',
  },
  servers: [{ url: '/', description: '현재 배포 주소' }],
  tags: [{ name: '인증', description: '카카오 로그인과 토큰 관리' }, { name: '계정' }, { name: '모임' }, { name: '지출' }, { name: '정산' }],
  paths: {
    ...documentedDomainPaths,
    '/auth/v1/openbanking': {
      get: { tags: ['인증'], summary: '금융결제원 사용자 인증 콜백', description: '일회용 state·시작 세션을 검사하고 서버에서 토큰을 교환합니다. 처리 중 탈퇴한 결과는 활성 연결로 저장하지 않습니다.', parameters: ['state', 'code', 'error'].map(name => ({ name, in: 'query', schema: string })), responses: { '303': { description: '안전한 온보딩 또는 계정 화면으로 복귀. 오류는 안전한 코드만 전달합니다.' } } },
    },
    '/api/auth/kakao': {
      get: {
        tags: ['인증'],
        summary: '카카오 로그인 시작',
        description: 'OIDC state·nonce·PKCE 쿠키와 안전한 복귀 목적지를 설정한 뒤 카카오 인증 화면으로 이동합니다.',
        parameters: [{ name: 'returnTo', in: 'query', schema: { type: 'string' }, description: '허용된 /home, /invites, /settlements 내부 경로. 외부·인증 루프 경로는 /home으로 대체합니다.' }],
        responses: {
          '307': { description: '카카오 인증 화면 또는 로그인 오류 화면으로 이동' },
        },
      },
    },
    '/auth/v1/kakao': {
      get: {
        tags: ['인증'],
        summary: '카카오 로그인 콜백',
        description: '인가 코드를 교환하고 OIDC sub를 검증합니다. 가입 완료 활성 회원은 app 세션, 신규·가입 미완료·탈퇴 회원은 10분 onboarding 세션을 발급합니다. 로그인만으로 재가입하지 않습니다.',
        parameters: [
          {
            name: 'code',
            in: 'query',
            required: true,
            schema: { type: 'string' },
            description: '카카오가 전달한 인가 코드',
          },
          {
            name: 'state',
            in: 'query',
            required: true,
            schema: { type: 'string' },
            description: '로그인 시작 시 설정한 state 값',
          },
          {
            name: 'error',
            in: 'query',
            required: false,
            schema: { type: 'string' },
            description: '카카오 인증 오류 코드',
          },
        ],
        security: [{ oidcStateCookie: [], oidcNonceCookie: [], oidcVerifierCookie: [] }],
        responses: {
          '307': { description: '성공 시 안전한 원래 목적지 또는 /onboarding, 실패 시 목적지를 유지한 /login으로 이동' },
        },
      },
    },
    '/api/auth/refresh': {
      post: {
        tags: ['인증'],
        summary: '액세스 토큰 재발급',
        description: '서명·만료·DB 해시와 활성 회원·가입 완료·app 세션 목적을 확인한 뒤 액세스·리프레시 JWT를 함께 회전합니다. onboarding 세션은 갱신하지 않습니다.',
        parameters: [
          {
            name: 'Origin',
            in: 'header',
            required: true,
            schema: { type: 'string', format: 'uri' },
            description: '현재 서비스 origin과 정확히 일치해야 합니다.',
          },
        ],
        security: [{ refreshCookie: [] }],
        responses: {
          '200': { $ref: '#/components/responses/Ok' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '503': { $ref: '#/components/responses/RefreshUnavailable' },
        },
      },
    },
    '/api/auth/logout': {
      post: {
        tags: ['인증'],
        summary: '로그아웃',
        description: '유효한 리프레시 토큰을 우선 사용하고, 없으면 유효한 액세스 토큰의 세션 ID로 DB 기록을 식별·삭제한 뒤 액세스·리프레시 쿠키를 제거합니다.',
        parameters: [
          {
            name: 'Origin',
            in: 'header',
            required: true,
            schema: { type: 'string', format: 'uri' },
            description: '현재 서비스 origin과 정확히 일치해야 합니다.',
          },
        ],
        responses: {
          '200': { $ref: '#/components/responses/Ok' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '503': { $ref: '#/components/responses/LogoutUnavailable' },
        },
      },
    },
    '/api/auth/withdraw': {
      post: {
        tags: ['인증'],
        summary: '회원 탈퇴',
        description: '참여 이력이 있는 미종료 회차가 있으면 409 unfinished_rounds로 차단합니다. 허용되면 deletedAt 설정·모든 세션 폐기·모임 이탈·금융결제원 해제 대기를 함께 저장합니다. 외부 연결 해제 실패는 지속 재시도하며 이전 해제 정리 전 새 금결원 인증·재가입은 보류합니다. 동일 카카오 재가입 시 같은 ID·과거 기록을 유지하고 이전 모임·관리 권한은 복원하지 않습니다.',
        parameters: [
          {
            name: 'Origin',
            in: 'header',
            required: true,
            schema: { type: 'string', format: 'uri' },
            description: '현재 서비스 origin과 정확히 일치해야 합니다.',
          },
        ],
        security: [{ accessCookie: [] }],
        responses: {
          '200': { description: '로컬 탈퇴 완료', content: { 'application/json': { schema: object({ ok: { type: 'boolean' }, openBankingDisconnect: { type: 'string', enum: ['completed', 'pending'] } }, ['ok', 'openBankingDisconnect']) } } },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '409': { $ref: '#/components/responses/DomainFailure' },
          '503': { $ref: '#/components/responses/DomainFailure' },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      accessCookie: {
        type: 'apiKey',
        in: 'cookie',
        name: 'da_moa_access',
        description: 'HttpOnly 액세스 JWT. app 세션은 5분이며 DB에서 세션 목적·소유자·만료·폐기와 회원 상태도 검증합니다.',
      },
      refreshCookie: {
        type: 'apiKey',
        in: 'cookie',
        name: 'da_moa_refresh',
        description: '14일 수명의 HttpOnly 리프레시 JWT',
      },
      oidcStateCookie: {
        type: 'apiKey',
        in: 'cookie',
        name: 'da_moa_oidc_state',
      },
      oidcNonceCookie: {
        type: 'apiKey',
        in: 'cookie',
        name: 'da_moa_oidc_nonce',
      },
      oidcVerifierCookie: {
        type: 'apiKey',
        in: 'cookie',
        name: 'da_moa_oidc_verifier',
      },
    },
    schemas: {
      ...domainSchemas,
      Ok: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: { ok: { type: 'boolean', enum: [true] } },
      },
      Unauthorized: {
        type: 'object',
        additionalProperties: false,
        required: ['error'],
        properties: { error: { type: 'string', enum: ['unauthorized'] }, message: { type: 'string' } },
      },
      Forbidden: {
        type: 'object',
        additionalProperties: false,
        required: ['error'],
        properties: { error: { type: 'string', enum: ['forbidden'] }, message: { type: 'string' } },
      },
      LogoutUnavailable: {
        type: 'object',
        additionalProperties: false,
        required: ['error'],
        properties: { error: { type: 'string', enum: ['logout_unavailable'] } },
      },
      RefreshUnavailable: {
        type: 'object',
        additionalProperties: false,
        required: ['error'],
        properties: { error: { type: 'string', enum: ['refresh_unavailable'] } },
      },
    },
    responses: {
      ...domainResponses,
      Ok: {
        description: '요청 성공',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Ok' },
            example: { ok: true },
          },
        },
      },
      Unauthorized: {
        description: '유효하지 않거나 만료된 인증 정보',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Unauthorized' },
            example: { error: 'unauthorized' },
          },
        },
      },
      Forbidden: {
        description: 'Origin 또는 서버 권한 검증 실패',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Forbidden' },
            example: { error: 'forbidden' },
          },
        },
      },
      LogoutUnavailable: {
        description: '로그아웃 처리 중 DB를 사용할 수 없음',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/LogoutUnavailable' },
            example: { error: 'logout_unavailable' },
          },
        },
      },
      RefreshUnavailable: {
        description: '액세스 토큰 재발급 중 리프레시 세션 저장소를 사용할 수 없음',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/RefreshUnavailable' },
            example: { error: 'refresh_unavailable' },
          },
        },
      },
    },
  },
} as const
