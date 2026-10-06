import { CURRENCY_CODES } from './money'
import { MAX_GROUP_MEMBERS } from '../Domain/Group/Shared'

type Schema = Record<string, unknown>
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: 'object', properties, ...(required.length ? { required } : {}) })
const array = (items: Schema): Schema => ({ type: 'array', items })
const string: Schema = { type: 'string' }
const integer: Schema = { type: 'integer', minimum: 1 }
const id: Schema = { type: 'string', format: 'uuid' }
const minor: Schema = { type: 'string', pattern: '^\\d+$', description: '통화 최소 단위의 정확한 정수 문자열. KRW·JPY·VND는 주 단위, 나머지 지원 통화는 주 단위의 1/100.' }
const currency: Schema = { type: 'string', enum: CURRENCY_CODES }
const status: Schema = { type: 'string', enum: ['RECORDING', 'CONFIRMED', 'LOCKED', 'COMPLETED'] }
const timestamp: Schema = { type: 'integer', format: 'int64', description: 'UTC epoch seconds' }
const nullableTimestamp: Schema = { ...timestamp, nullable: true }
const profileImage: Schema = { type: 'string', format: 'uri', nullable: true, description: '활성 회원의 최신 카카오 프로필 이미지 URL. 탈퇴했거나 이미지가 없으면 null.' }
const bankFields = { bankName: { type: 'string', minLength: 1, maxLength: 100 }, accountNumber: { type: 'string', minLength: 1, maxLength: 100, description: '구분자 없는 원본 계좌번호. 선행 0을 보존합니다.' }, formattedAccountNumber: { type: 'string', nullable: true, description: '선택 은행의 규칙으로 저장한 표시용 계좌번호. 이전에 등록한 계좌는 null일 수 있습니다.' }, accountHolder: { type: 'string', minLength: 1, maxLength: 100 } }
const bankVersion: Schema = { type: 'integer', minimum: 0 }
const bankInputFields = {
  bankCode: { type: 'string', pattern: '^\\d{3}$', description: '지원 금융기관의 표준 코드' },
  accountNumber: { type: 'string', maxLength: 64, description: '숫자·ASCII 공백·하이픈. 정규화 후 숫자 1~16자리이며 선택 은행의 알려진 규칙과 일치해야 합니다.' },
  accountHolder: { type: 'string', minLength: 1, maxLength: 100, description: 'NFC·앞뒤 공백 정리 후 1~40자. 계좌실명조회 응답과 정확히 비교합니다.' },
  expectedBankVersion: bankVersion,
}
const bankInputRequired = ['bankCode', 'accountNumber', 'accountHolder', 'expectedBankVersion']
const versionBody = object({ expectedVersion: integer }, ['expectedVersion'])
const settlementCheckBody = object({ expectedVersion: integer, checked: { type: 'boolean' }, currency: { ...currency, description: '송금자 지정 시 필수. 해당 통화 수취 건만 확인하거나 해제합니다.' }, senderId: { ...id, description: '생략하면 본인의 모든 수취 건, 지정하면 currency와 함께 해당 송금자의 통화별 한 건만 변경합니다.' } }, ['expectedVersion', 'checked'])
const expenseFields = {
  currency,
  description: string,
  amount: { type: 'string', pattern: '^\\d+(\\.\\d{1,2})?$', description: '양의 십진 문자열. KRW·JPY·VND는 정수, 나머지 지원 통화는 소수 최대 2자리. 통화의 주 단위 기준 지출 한 건 최대 100,000,000. 숫자·지수표기·쉼표·환불 금액은 거부.' },
  payerId: id,
  splitMode: { type: 'string', enum: ['ALL', 'SELECTED', 'CUSTOM'] },
  participantIds: { type: 'array', items: id, minItems: 1, uniqueItems: true, description: 'SELECTED 생성 시 필수이며 수정 시 생략하면 이전 부담자를 유지합니다. ALL은 서버가 회차의 제외되지 않은 전원으로 결정. CUSTOM에서는 보내지 않습니다.' },
  customShares: { ...array(object({ userId: id, amount: { type: 'string', pattern: '^\\d+(\\.\\d{1,2})?$', description: '회차 통화 주 단위의 양의 부담금 문자열. KRW·JPY·VND는 정수, 나머지 지원 통화는 소수 최대 2자리.' } }, ['userId', 'amount'])), minItems: 1, maxItems: MAX_GROUP_MEMBERS, description: 'CUSTOM 생성·전환 시 필수. 제외되지 않은 부담자별 정확한 금액이며 userId 중복은 금지합니다. 합계는 총 amount와 같아야 합니다. 기존 CUSTOM 수정에서 생략하면 이전 부담금을 유지합니다. ALL·SELECTED에서는 보내지 않습니다.' },
  expectedVersion: integer,
}
const pageParameters = [
  { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, minimum: 1, maximum: 100 } },
  { name: 'cursor', in: 'query', schema: string, description: '(created_at, id)에 기반한 서버 발급 커서' },
]
const roundSearchParameter = { name: 'q', in: 'query', schema: { type: 'string', minLength: 1, maxLength: 100 }, description: '모임명 또는 회차명의 대소문자를 구분하지 않는 부분 검색어' }
const groupSearchParameter = { name: 'q', in: 'query', schema: { type: 'string', minLength: 1, maxLength: 100 }, description: '모임명의 대소문자를 구분하지 않는 부분 검색어' }
const mutationParameters = [
  { name: 'Origin', in: 'header', required: true, schema: { type: 'string', format: 'uri' }, description: '현재 서비스 origin과 정확히 일치해야 합니다.' },
  { name: 'Idempotency-Key', in: 'header', required: true, schema: id, description: '한 제출당 한 UUID. 네트워크·토큰 갱신 후 재시도에도 같은 키와 본문을 사용합니다.' },
]
const domainResponses = {
  DomainFailure: {
    description: '요청 오류. 409는 상태·버전·제외·인원 제한·미종료 회차·멱등 키 충돌, 503은 같은 키로 재시도할 저장소·외부 서비스 오류입니다.',
    content: { 'application/json': { schema: ref('ApiError') } },
  },
}
const groupFields = { id, creatorId: { ...id, description: '모임 생성자 ID. 초대와 모임 관리를 담당합니다.' }, name: string, createdAt: timestamp }
const roundFields = {
  id, groupId: id, groupName: string, name: string, status, version: integer, createdAt: timestamp,
  finalizedAt: nullableTimestamp, completedAt: nullableTimestamp,
  totals: { ...array(ref('CurrencyTotal')), maxItems: 5, description: '기록된 통화별 합계. 통화가 다른 금액은 합산하지 않습니다. 지출이 없으면 빈 배열.' }, memberCount: { type: 'integer', minimum: 0 },
}
const domainSchemas = {
  Currency: currency,
  CurrencyTotal: object({ currency, totalMinor: minor, balanceMinor: { type: 'string', pattern: '^-?\\d+$', nullable: true } }, ['currency', 'totalMinor', 'balanceMinor']),
  CurrencyBalance: object({ currency, balanceMinor: { type: 'string', pattern: '^-?\\d+$' } }, ['currency', 'balanceMinor']),
  RoundStatus: status,
  MinorAmount: minor,
  ApiError: object({
    error: { type: 'string', example: 'stale_round', description: 'invalid_input, invalid_amount, custom_share_total_mismatch, expense_amount_limit_exceeded, round_total_limit_exceeded, round_currency_limit_exceeded, invalid_participants, unsupported_currency, unauthorized, forbidden, onboarding_required, not_found, stale_round, invalid_round_state, idempotency_conflict, empty_expenses, pending_settlement_checks, member_exclusion_blocked, minimum_participants, group_member_limit_exceeded, unfinished_rounds, unfinished_group_rounds, unsupported_receipt_type, receipt_too_large, receipt_pending, storage_unavailable 등' },
    message: string,
    details: { type: 'object', additionalProperties: true, description: '현재 버전, 제외 차단 관련 지출 또는 탈퇴를 막는 회차 등. 계좌·인증 토큰은 포함하지 않음.' },
  }, ['error', 'message']),
  BankAccount: { ...object(bankInputFields, bankInputRequired), additionalProperties: false },
  CurrentBankAccount: object({ bankName: { type: 'string', nullable: true }, accountNumber: { type: 'string', nullable: true }, formattedAccountNumber: { type: 'string', nullable: true, description: '저장된 표시용 번호. 이전에 등록한 계좌는 null일 수 있습니다.' }, accountHolder: { type: 'string', nullable: true }, verifiedAt: { ...nullableTimestamp, description: 'null이면 계좌번호와 함께 “확인되지 않은 계좌입니다.”를 표시합니다.' } }, ['bankName', 'accountNumber', 'formattedAccountNumber', 'accountHolder', 'verifiedAt']),
  Me: object({ id, displayName: { type: 'string', nullable: true }, email: { type: 'string', nullable: true }, profileImageUrl: profileImage, purpose: { type: 'string', enum: ['app', 'onboarding'] }, deletedAt: nullableTimestamp, onboardingCompletedAt: nullableTimestamp, bankVersion, bankAccount: { type: 'object', nullable: true, properties: { ...bankFields, bankCode: { type: 'string', nullable: true }, verifiedAt: nullableTimestamp }, description: '본인의 현재 대표 계좌. verifiedAt=null이면 “확인되지 않은 계좌입니다.”를 표시합니다. 계좌는 직접 입력하며 자동 확인을 제공하지 않습니다.' } }, ['id', 'displayName', 'email', 'profileImageUrl', 'purpose', 'deletedAt', 'onboardingCompletedAt', 'bankAccount', 'bankVersion']),
  Group: object(groupFields, Object.keys(groupFields)),
  GroupListItem: object({ ...groupFields, memberCount: { type: 'integer', minimum: 1, maximum: MAX_GROUP_MEMBERS }, memberPreview: { ...array(object({ userId: id, displayName: string, profileImageUrl: profileImage }, ['userId', 'displayName', 'profileImageUrl'])), maxItems: 5 } }, [...Object.keys(groupFields), 'memberCount', 'memberPreview']),
  GroupMember: object({ userId: id, displayName: string, excludedAt: nullableTimestamp }, ['userId', 'displayName', 'excludedAt']),
  GroupDetail: object({ ...groupFields, members: { ...array(ref('GroupMember')), maxItems: MAX_GROUP_MEMBERS, description: '활성 멤버만 포함하며 생성자가 첫 번째입니다.' }, isCreator: { type: 'boolean', description: '조회 사용자가 현재 활성 모임 생성자인지 여부' }, invites: array(object({ id, expiresAt: timestamp }, ['id', 'expiresAt'])) }, [...Object.keys(groupFields), 'members', 'isCreator', 'invites']),
  Round: object(roundFields, Object.keys(roundFields)),
  RoundMember: object({ userId: id, displayName: string, profileImageUrl: profileImage, excludedAt: nullableTimestamp }, ['userId', 'displayName', 'profileImageUrl', 'excludedAt']),
  Expense: object({ id, authorId: id, payerId: id, description: string, currency, amountMinor: minor, splitMode: expenseFields.splitMode, participantIds: array(id), baseShareMinor: { ...minor, nullable: true }, remainderUnits: { type: 'integer', minimum: 0, nullable: true }, shares: array(object({ userId: id, assignedAmountMinor: { ...minor, nullable: true, description: 'CUSTOM에서 지정한 원본 부담금. 균등 분배에서는 null이며 재오픈해도 원본은 유지됩니다.' }, amountMinor: { ...minor, nullable: true, description: '최종 저장된 부담금. 최종화 전에는 CUSTOM도 null입니다.' }, receivedRemainder: { type: 'boolean', nullable: true } }, ['userId', 'assignedAmountMinor', 'amountMinor', 'receivedRemainder'])), receipts: array(ref('Receipt')), createdAt: timestamp, updatedAt: timestamp }, ['id', 'authorId', 'payerId', 'description', 'currency', 'amountMinor', 'splitMode', 'participantIds', 'baseShareMinor', 'remainderUnits', 'shares', 'receipts', 'createdAt', 'updatedAt']),
  Receipt: object({ id, mimeType: { type: 'string', enum: ['image/avif', 'image/jpeg', 'image/png', 'image/webp'], description: '신규 업로드는 image/avif이며 나머지는 기존 저장 자료 조회 호환 값입니다.' }, byteSize: { type: 'integer', minimum: 1, description: '저장할 이미지의 바이트 크기입니다. 신규 업로드 파일은 최대 10 MiB이며 기존 자료는 이 상한 이전의 파일을 포함할 수 있습니다.' }, storageStatus: { type: 'string', enum: ['PENDING', 'READY', 'FAILED'], description: '저장 중·조회 가능·최종 저장 실패. 실패한 영수증은 삭제 후 다시 업로드할 수 있습니다.' } }, ['id', 'mimeType', 'byteSize', 'storageStatus']),
  SettlementTransfer: object({ currency, senderId: id, receiverId: id, amountMinor: minor }, ['currency', 'senderId', 'receiverId', 'amountMinor']),
  RoundDetail: object({ ...roundFields, creatorId: { ...id, description: '회차 생성자 ID. 해당 회차 수명주기와 전체 지출을 관리합니다.' }, groupCreatorId: { ...id, description: '소속 모임 생성자 ID. 회차 생성자와 다를 수 있습니다.' }, isCreator: { type: 'boolean', description: '조회 사용자가 이 회차의 생성자인지 여부' }, members: array(ref('RoundMember')), expenses: array(ref('Expense')), expensesNextCursor: { type: 'string', nullable: true }, transfers: { ...array(ref('SettlementTransfer')), description: '조회 사용자가 보내거나 받는 송금 관계만 포함합니다.' }, pendingRemainders: array(object({ currency, amountMinor: minor }, ['currency', 'amountMinor'])) }, [...Object.keys(roundFields), 'creatorId', 'groupCreatorId', 'isCreator', 'members', 'expenses', 'expensesNextCursor', 'transfers', 'pendingRemainders']),
  MutationResult: object({ id, roundId: id, status, version: integer, inviteId: id, linkUnavailable: { type: 'boolean' }, sharePath: { type: 'string', description: '초대 최초 발급에서만 /invites/{token} 경로를 반환하며 재시도 기록에는 저장하지 않음' } }, ['id']),
  ExclusionCheck: object({ allowed: { type: 'boolean' }, reason: { type: 'string', nullable: true }, expenses: array(object({ id, description: string, currency, amountMinor: minor, authorId: id, authorName: string, reason: string }, ['id', 'description', 'currency', 'amountMinor', 'authorId', 'authorName', 'reason'])) }, ['allowed', 'reason', 'expenses']),
  OutgoingTransfer: object({ currency, receiverId: id, displayName: string, profileImageUrl: profileImage, amountMinor: minor, account: ref('CurrentBankAccount') }, ['currency', 'receiverId', 'displayName', 'profileImageUrl', 'amountMinor']),
  IncomingTransfer: object({ currency, senderId: id, displayName: string, profileImageUrl: profileImage, amountMinor: minor, receivedAt: nullableTimestamp }, ['currency', 'senderId', 'displayName', 'profileImageUrl', 'amountMinor', 'receivedAt']),
  SettlementConfirmation: object({ userId: id, displayName: string, profileImageUrl: profileImage, checkedAt: nullableTimestamp }, ['userId', 'displayName', 'profileImageUrl', 'checkedAt']),
  Settlement: object({ roundId: id, name: string, groupName: string, status, version: integer, isCreator: { type: 'boolean', description: '조회 사용자가 이 회차의 생성자인지 여부' }, finalized: { type: 'boolean' }, balances: { ...array(ref('CurrencyBalance')), maxItems: 5, description: '최종 통화별 부담액 − 결제액. 최종 저장 전에는 빈 배열.' }, checkedAt: nullableTimestamp, checkRequired: { type: 'boolean', description: '조회 사용자가 한 건 이상 수취하는지 여부' }, checkedCount: { type: 'integer', minimum: 0, description: '모든 수취 건을 확인한 수취인 수' }, requiredCount: { type: 'integer', minimum: 0, description: '한 건 이상 수취하는 사용자 수' }, allChecked: { type: 'boolean', description: '모든 송금 건의 수취 확인 여부. 송금 건이 없으면 true.' }, confirmations: { ...array(ref('SettlementConfirmation')), description: '수취인별 이름 스냅샷, 활성 카카오 프로필, 전체 수취 완료 시각. 한 건이라도 미확인이면 checkedAt은 null입니다.' }, outgoing: { ...array(ref('OutgoingTransfer')), description: '조회 사용자가 아직 보내야 하는 미확인 송금. 수취 확인 시 제외되고 확인 해제 시 복원됩니다.' }, incoming: array(ref('IncomingTransfer')), sharePath: { type: 'string', nullable: true, example: '/settlements/00000000-0000-4000-8000-000000000001', description: '최종 저장 후 제공하며 이전에는 null. 로그인한 본인의 안내를 조회하는 경로이며 초대 링크가 아님.' } }, ['roundId', 'name', 'groupName', 'status', 'version', 'isCreator', 'finalized', 'balances', 'checkedAt', 'checkRequired', 'checkedCount', 'requiredCount', 'allChecked', 'confirmations', 'outgoing', 'incoming', 'sharePath']),
  GroupPage: object({ items: array(ref('GroupListItem')), nextCursor: { type: 'string', nullable: true } }, ['items', 'nextCursor']),
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
    description: options.description ?? 'Node JWT Guard에서 입력 검사 전에 JWT를 검증하고, DB에서 회원 상태 및 리소스 권한을 검증하며 세션 유효성은 조회하지 않습니다. 응답은 private, no-store입니다.',
    security: [{ accessBearer: [] }],
    parameters: [...(options.mutation ? mutationParameters : []), ...(options.parameters ?? [])],
    ...(options.request ? { requestBody: { required: true, content: { [options.multipart ? 'multipart/form-data' : 'application/json']: { schema: options.request } } } } : {}),
    responses: {
      [options.multipart ? '202' : '200']: { description: options.multipart ? '영속 큐 접수 완료. 파일 저장 완료는 storageStatus=READY로 확인합니다.' : '요청 성공', content: { 'application/json': { schema: object({ data: options.response ?? ref('MutationResult') }, ['data']) } } },
      ...Object.fromEntries(['400', '401', '403', '404', '409', '422', '424', '429', '503', ...(options.multipart ? ['413', '415'] : [])].map(code => [code, { $ref: '#/components/responses/DomainFailure' }])),
    },
  }
}
const roundCommand = (summary: string, description: string) => operation('정산', summary, { mutation: true, request: versionBody, description })
const healthCheck: Schema = { type: 'string', enum: ['ok', 'down'] }
function healthOperation(summary: string, names: string[]) {
  const dependencyCheck = names.some(name => name === 'database' || name === 'minio')
  const checks = object(Object.fromEntries(names.map(name => [name, name === 'application' ? { type: 'string', enum: ['ok'] } : healthCheck])), names)
  const response = { content: { 'application/json': { schema: object({ status: dependencyCheck ? healthCheck : { type: 'string', enum: ['ok'] }, checks }, ['status', 'checks']) } } }
  return { tags: ['상태'], summary, description: '인증 없이 조회합니다. 결과를 캐시하지 않으며 내부 오류·연결 정보는 반환하지 않습니다.', security: [], responses: { '200': { description: '모든 검사 정상', ...response }, ...(dependencyCheck ? { '503': { description: '하나 이상의 의존 서비스 장애', ...response } } : {}) } }
}
const domainPaths = {
  '/api/me': { get: operation('계정', '본인 프로필·가입 상태·계좌 조회', { response: ref('Me'), description: 'app 또는 onboarding 목적의 JWT로 본인 데이터만 조회합니다. 일반 기능은 가입 완료 회원의 app JWT가 필요합니다.' }) },
  '/api/me/onboarding': { post: operation('계정', '계좌 저장 후 가입·명시적 재가입 완료', { response: object({ id, returnTo: string, accessToken: string }, ['id', 'returnTo', 'accessToken']), request: { ...object({ ...bankInputFields, confirmRejoin: { type: 'boolean', description: '탈퇴 계정의 명시적 재가입 동의' } }, bankInputRequired), additionalProperties: false }, parameters: [mutationParameters[0]], description: '은행·계좌번호·예금주를 직접 입력해 가입을 완료합니다. 계좌·가입 상태를 원자적으로 저장하고 새 app JWT를 발급하며 기존 모임·관리 권한은 복구하지 않습니다. 토큰 응답 유실은 카카오 재로그인으로 복구합니다.' }) },
  '/api/me/bank-account': { put: operation('계정', '대표 계좌 저장', { mutation: true, request: ref('BankAccount'), response: object({ id, bankVersion }, ['id', 'bankVersion']), description: 'AUTH 회원 조회 후 입력을 검증하고 expectedBankVersion이 일치하는 활성 회원의 계좌만 조건부 UPDATE합니다. 트랜잭션·명시적 락 없이 SQL 2회이며 갱신 실패는 409 bank_account_conflict입니다. 같은 버전의 재전송도 409이며 최신 내 정보를 다시 조회해야 합니다. 요청 키 형식만 검증하고 성공 기록은 조회·저장하지 않습니다. 계좌가 바뀌면 기존 확인 이력을 초기화하고, 진행 중 정산도 계좌 교체를 막지 않습니다.' }) },
  '/api/groups': {
    get: operation('모임', '활성 모임 목록', { response: ref('GroupPage'), parameters: [pageParameters[0], { ...pageParameters[1], description: '모임 ID 내림차순 서버 발급 커서. 조회에는 id만 사용하며 기존 커서 형식의 createdAt은 호환을 위해 유지합니다.' }, groupSearchParameter], description: 'Node JWT Guard를 먼저 통과한 뒤 트랜잭션 없이 AUTH 회원 조회 → 모임·활성 멤버 ID 조회 → Set으로 중복 제거한 회원 프로필 조회, 총 SQL 3회입니다. 모임 ID 내림차순으로 limit+1개를 먼저 선택한 뒤 멤버를 집계합니다. q는 제목 ILIKE 부분 검색이며 %, _, 역슬래시는 문자 그대로 찾습니다. 빈 목록은 프로필 조회를 생략해 2회입니다.' }),
    post: operation('모임', '모임 생성', { parameters: [{ ...mutationParameters[1], schema: { ...id, pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' }, description: '모임 PK로 사용할 UUIDv7. 같은 키 재전송은 409로 거절합니다.' }, mutationParameters[0]], request: { ...object({ name: string }, ['name']), additionalProperties: false }, description: 'JWT·회원 상태를 확인한 뒤 UUIDv7 Idempotency-Key를 모임 PK로 사용합니다. 명시적 트랜잭션 없이 모임·생성자 멤버십을 한 SQL로 저장하고 총 AUTH+생성 2회입니다. 같은 PK는 409 group_already_exists로 거절하며 멱등 기록 조회·저장은 하지 않습니다.' }),
  },
  '/api/groups/{groupId}': {
    get: operation('모임', '모임 상세 정보', { response: ref('GroupDetail'), description: 'JWT 회원 조회 1회 → 모임·활성 group_members·users를 JOIN하여 멤버 이름까지 조회하고 본인의 참여 여부 비교 1회 → 생성자인 경우에만 유효 초대 조회 1회입니다. 명시적 트랜잭션 없이 일반 멤버는 SQL 2회, 생성자는 3회이며 멤버 목록을 함께 반환하며 회차는 포함하지 않습니다. 초대 원문 링크는 최초 발급 응답에서만 제공합니다.' }),
    delete: operation('모임', '모임 나가기 또는 없애기', { mutation: true, description: '일반 참여자는 본인이 참여 중인 미종료 회차가 없을 때 현재 멤버십의 leftAt을 기록하고 나갑니다. 모임 생성자는 본인 참여 여부와 무관하게 모임 전체의 모든 회차가 종료된 경우에만 모든 멤버십을 종료하고 초대를 폐기합니다. 완료된 회차와 모임 이름은 과거 정산 조회를 위해 보존합니다.' }),
  },
  '/api/groups/{groupId}/rounds': {
    get: operation('모임', '본인 참여 권한이 있는 모임 회차 목록', { response: ref('RoundPage'), parameters: [...pageParameters, roundSearchParameter] }),
    post: operation('모임', '선택한 멤버로 기록 시작', { parameters: [{ ...mutationParameters[1], schema: { ...id, pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' }, description: '회차 PK로 사용할 UUIDv7 ticket. Idempotency-Key 헤더로 전달하며 같은 키 재전송은 409로 거절합니다.' }, mutationParameters[0]], request: { ...object({ name: string, participantIds: { type: 'array', items: id, minItems: 2, maxItems: MAX_GROUP_MEMBERS, uniqueItems: true, description: '현재 활성 모임 멤버 중 요청자 자신을 반드시 포함합니다.' } }, ['name', 'participantIds']), additionalProperties: false }, description: '공용 세션 advisory lock 획득 → AUTH 내 정보 조회 → 이름·참여자·UUIDv7 ticket 검증 → 단일 조건부 SQL로 회차와 참여자 저장 → 같은 연결에서 락 해제의 SQL 4회입니다. 모임 이탈·닫기·회원 탈퇴와 같은 락으로 AUTH부터 저장까지 보호하며 실패 시에도 해제하고 해제 결과가 불확실하면 연결을 폐기합니다. 명시적 트랜잭션·멱등 성공 기록 없이 ticket을 PK로 사용하며 중복 PK는 409 round_already_exists입니다. 없는/탈퇴한 요청자는 401 unauthorized, 비멤버·없는 모임은 404 not_found, 비활성·외부 참여자는 400 invalid_participants입니다. 응답 유실 후 같은 ticket 재시도도 409이며 회차 목록에서 결과를 확인합니다. 모임 이탈·회원 탈퇴와는 저장 SQL의 스냅샷 기준으로 검사하며 직렬화하지 않습니다. 모든 활성 모임 참여자가 요청자 자신을 포함한 최소 2명을 선택해 회차를 만들 수 있습니다. 요청자가 회차 생성자가 되어 해당 회차 수명주기와 전체 지출을 관리하며, 모임 생성자는 필수 참여자가 아닙니다. 회차 생성 요청에는 통화를 받지 않습니다. 각 지출에서 지원 통화를 선택하고 기록 단계에서 변경할 수 있으며 한 회차에 최대 5개 통화를 기록합니다. 미완료 회차가 있어도 생성할 수 있습니다.' }),
  },
  '/api/groups/{groupId}/invites': { post: operation('모임', '7일 유효 초대 발급·재발급', { mutation: true, request: object({ replaceInviteId: id }), description: '모임 생성자가 발급하며 원문 링크는 최초 응답에서만 제공합니다. 같은 키 재시도는 inviteId와 linkUnavailable을 반환합니다. 새 키와 replaceInviteId로 이전 초대를 폐기하며 다시 발급합니다.' }) },
  '/api/groups/{groupId}/invites/{inviteId}': { delete: operation('모임', '모임 생성자가 초대 폐기', { mutation: true }) },
  '/api/invites/{token}': { get: operation('모임', '인증 후 초대 모임 미리보기', { response: object({ groupId: id, groupName: string, isMember: { type: 'boolean' }, expiresAt: timestamp }, ['groupId', 'groupName', 'isMember', 'expiresAt']), description: '조회만으로 멤버십을 생성하지 않습니다. 만료·폐기되었거나 활성 모임 생성자가 없는 초대는 거부합니다.' }) },
  '/api/invites/{token}/accept': { post: operation('모임', '초대를 명시적으로 수락', { mutation: true, description: 'AUTH → 토큰 형식 검사 → 유효 초대/성공 기록 조회 → 세션 락 획득 → 조건부 멤버십·성공 기록 단일 SQL → 락 해제의 5회이며 명시적 트랜잭션은 없습니다. 기존 쓰기와 같은 advisory lock으로 정원을 보호하며 삽입 시 회원·초대·생성자·현재 정원을 다시 확인합니다. 새 키의 활성 멤버 중복 수락·동시 삽입 충돌은 409 group_already_member, 정원 초과는 409 group_member_limit_exceeded입니다. 이미 성공한 같은 키는 기존 결과를 반환합니다. 이탈자는 재참여할 수 있으며 기존 회차에는 자동 추가되지 않습니다.' }) },
  '/api/rounds': { get: operation('정산', '본인 참여 이력으로 회차 목록 조회', { response: ref('RoundPage'), parameters: [...pageParameters, roundSearchParameter, { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'RECORDING', 'CONFIRMED', 'LOCKED', 'COMPLETED'] } }], description: '현재 모임 멤버십과 무관하게 본인 참여 이력이 있는 회차를 조회합니다. 다른 회차·통화 금액을 합산하지 않습니다.' }) },
  '/api/rounds/{roundId}': {
    get: operation('정산', '회차·지출·참여 내역 조회', { response: ref('RoundDetail'), parameters: pageParameters, description: 'creatorId는 회차 생성자, groupCreatorId는 모임 생성자이며 isCreator는 조회 사용자가 회차 생성자인지를 뜻합니다. 같은 DB 스냅샷의 원본과 버전을 반환합니다. 회차 참여자의 이름과 활성 회원의 최신 카카오 프로필 이미지를 반환하며 탈퇴자의 이미지는 null입니다. 최종화 전에는 각 지출의 균등 기본 몫과 개별 지정 부담금을 회차 전체에서 상계한 예상 송금 관계와 미배분 나머지 금액을, 최종화 뒤에는 저장된 최종 관계를 반환합니다. 송금 관계는 조회 사용자가 보내거나 받는 행만 포함하며 계좌정보는 반환하지 않습니다.' }),
    delete: roundCommand('기록 단계 회차 전체 취소', '회차 생성자만 지출 기록이 없는 RECORDING 회차를 취소합니다. 지출이 있으면 409 round_has_expenses로 거절하며 지출을 먼저 삭제해야 합니다. 재오픈 후에도 지출이 없어야 취소 가능하며 같은 키 재시도는 기존 성공 결과를 반환합니다. BEGIN → AUTH → 락 → 기록·권한·버전·재시도 조회 → 삭제·성공 기록 저장 → COMMIT의 SQL 6회이며 거절은 ROLLBACK으로 락을 해제합니다.'),
  },
  '/api/rounds/{roundId}/expenses': { post: operation('지출', '지출 생성', { mutation: true, request: object(expenseFields, ['currency', 'description', 'amount', 'payerId', 'splitMode', 'expectedVersion']), description: '기록 단계의 제외되지 않은 참여자가 작성합니다. 결제자 한 명과 전체·선택 사용자 균등 분배 또는 개별 항목 분배(CUSTOM)를 지정하며 작성자는 로그인 사용자로 저장합니다. CUSTOM은 participantIds 대신 customShares의 부담자·금액을 받으며 총 금액과 다르면 400 custom_share_total_mismatch와 “부담금 합계가 총 금액과 일치해야 해요”를 반환합니다. 통화 주 단위 기준 한 건은 100,000,000 이하, 통화별 회차 누적은 1,000,000,000 이하만 허용합니다. currency는 지원 통화 중 하나여야 하며 한 회차의 통화 종류는 최대 5개입니다. 저장 SQL에서도 통화별 합계와 종류 수를 재검사합니다.' }) },
  '/api/rounds/{roundId}/expenses/{expenseId}': {
    patch: operation('지출', '지출 수정', { mutation: true, request: object(expenseFields, ['expectedVersion']), description: '기록 단계에서 제외되지 않은 원작성자 또는 해당 회차 생성자만 수정합니다. 모임 생성자라는 이유만으로 수정할 수 없으며 작성자·회차는 변경할 수 없으며 지출 통화는 변경할 수 있습니다. 통화 변경 시 amount, 기존 CUSTOM의 경우 customShares도 다시 입력해야 합니다. 수정 금액으로 기존 금액을 대체해 한 건 100,000,000·회차 누적 1,000,000,000 한도를 다시 검증합니다. 기존 제외된 비부담 결제자의 관계는 보존할 수 있습니다. 기존 CUSTOM 수정에서 customShares를 생략하면 원본 부담금을 유지하되 변경된 총 금액과 합계를 다시 비교합니다. CUSTOM 전환은 customShares가 필수이고 ALL·SELECTED 전환 시 지정 부담금을 제거합니다.' }),
    delete: operation('지출', '지출·분담·증빙 삭제', { mutation: true, request: versionBody, description: '기록 단계에서 제외되지 않은 원작성자 또는 해당 회차 생성자만 지출과 연결 자료를 삭제합니다. 모임 생성자라는 이유만으로 삭제할 수 없습니다.' }),
  },
  '/api/rounds/{roundId}/expenses/{expenseId}/receipts': { post: operation('지출', '영수증 증빙 이미지 업로드', { mutation: true, multipart: true, request: object({ file: { type: 'string', format: 'binary', description: '브라우저 WASM Worker에서 변환한 .avif 파일. 실제 AV1 코덱의 단일 AVIF 이미지와 image/avif MIME만 허용하며 최대 10 MiB(10,485,760바이트)입니다. 앱의 multipart 본문 상한은 10 MiB + 64 KiB이며 초과 시 413 receipt_too_large입니다. OCR을 수행하지 않습니다.' }, expectedVersion: integer }, ['file', 'expectedVersion']), description: '기록 단계에서 제외되지 않은 지출 원작성자 또는 해당 회차 생성자가 이미 저장된 지출에 파일 하나를 별도로 업로드합니다. AUTH 회원 조회 후 파일 크기·확장자·MIME·실제 AV1 코덱을 검증합니다. 단일 SQL에서 권한·상태·버전을 검사하여 PENDING 영수증·회차 버전·멱등 결과와 DB 영속 큐를 함께 저장하고 202로 응답합니다. 워커는 MinIO PUT 뒤 단일 SQL로 객체 키와 READY 상태를 기록합니다. 요청의 업무 SQL은 2회, 워커의 저장 SQL은 1회이며 큐 제어 SQL은 별도입니다. 업로드 실패는 지출 원본을 삭제하지 않으며 목록 응답에는 바이트 본문이 없습니다.' }) },
  '/api/rounds/{roundId}/expenses/{expenseId}/receipts/{receiptId}': { delete: operation('지출', '영수증 증빙 삭제', { mutation: true, request: versionBody, description: '기록 단계에서 제외되지 않은 지출 원작성자 또는 해당 회차 생성자만 증빙을 삭제합니다. AUTH 회원 조회 → 권한·상태·버전·재시도 통합 조회 → 영수증 삭제·회차 버전·성공 기록 단일 SQL의 총 3회이며 명시적 트랜잭션·advisory lock은 없습니다. 저장 SQL에서 현재 조건을 다시 검사하며 DB 자동 커밋 후 MinIO 객체를 삭제합니다. 같은 키·본문의 성공 재생은 SQL 2회로 기존 결과를 반환하고 객체 삭제·알림을 반복하지 않습니다.' }) },
  '/api/receipts/{receiptId}': { get: { ...operation('지출', '참여 이력 검증 후 영수증 이미지 조회'), responses: { '200': { description: '신규 업로드는 AVIF, 기존 자료는 저장된 JPEG·PNG·WebP로 응답합니다. private, no-store 및 nosniff 헤더를 적용합니다.', content: Object.fromEntries(['image/avif', 'image/jpeg', 'image/png', 'image/webp'].map(mime => [mime, { schema: { type: 'string', format: 'binary' } }])) }, '401': { $ref: '#/components/responses/DomainFailure' }, '404': { $ref: '#/components/responses/DomainFailure' }, '409': { $ref: '#/components/responses/DomainFailure' }, '503': { $ref: '#/components/responses/DomainFailure' } } } },
  '/api/rounds/{roundId}/members/{userId}/exclusion-check': { get: operation('정산', '회차 사용자 제외 가능 여부와 관련 지출 확인', { response: ref('ExclusionCheck'), description: '회차 생성자만 조회합니다. 본인은 제외할 수 없고 모임 생성자는 다른 참여자와 같은 조건으로 검사합니다. 결제자 겸 부담자·SELECTED 또는 CUSTOM 부담자·최소 인원 위반을 확인하고 관련 지출 전체를 반환합니다. 이 검사는 데이터를 변경하지 않습니다.' }) },
  '/api/rounds/{roundId}/members/{userId}/exclude': { post: roundCommand('회차 사용자 제외와 ALL 재분배', 'AUTH → 회차·대상 통합 조회 → 조건부 단일 제외 저장의 SQL 3회이며 명시적 트랜잭션·락은 없습니다. 같은 키/새 키 재요청에서 이미 제외됐거나 대상 참여 이력이 없으면 404입니다. 회차 생성자만 기록 단계에서 제외 조건을 다시 검사합니다. 본인은 제외할 수 없고 모임 생성자는 다른 참여자와 같은 조건으로 제외할 수 있습니다. 차단 시 해당 사용자와 연관된 정산이 있습니다. 메시지와 관련 내역을 반환하며 아무것도 변경하지 않습니다. 성공 시 round_members.excluded_at과 해당 회차의 ALL 분배만 수정합니다. group_members.left_at, 다른 회차, 다음 회차 후보와 비부담 결제자 수취 관계는 보존합니다.') },
  '/api/rounds/{roundId}/confirm': { post: roundCommand('정산 확정', '회차 생성자가 RECORDING 회차의 모든 지출을 재검증하고 기본 몫·나머지를 저장합니다. CUSTOM은 원본 부담금 합계를 검증하고 나머지를 만들지 않습니다. 지출 0건이면 409 empty_expenses와 지출 내역이 없습니다 메시지를 반환합니다. 이 단계에서는 추첨하지 않습니다.') },
  '/api/rounds/{roundId}/reopen': { post: roundCommand('확정 회차를 기록 단계로 재오픈', 'AUTH → 회차 조회 → 회차 생성자·상태·버전 검사 → 단일 저장 SQL 3회로 처리하며 명시적 트랜잭션·락은 없습니다. 회차 생성자만 미전송·미종료 CONFIRMED 회차를 RECORDING으로 되돌립니다. 기본 몫·나머지 초기화와 상태·버전 증가를 원자적으로 저장하고 개별 지정 부담금을 포함한 지출 원본·증빙은 유지합니다. 성공 응답을 재생하지 않으며 같은 키/새 키 재요청은 이미 기록 중인 상태에서 409 invalid_round_state로 거절합니다. 동시 변경은 409 stale_round입니다. 이후 수정 → 확정 흐름을 다시 따릅니다.') },
  '/api/rounds/{roundId}/send': { post: roundCommand('전송을 확인하고 회차 잠금', '회차 생성자가 CONFIRMED 회차를 LOCKED로 전환합니다. 실제 메시지를 전송하지 않습니다. 원본·참여자 수정과 재오픈·취소는 이후 불가합니다. 나머지가 없으면 결과를 함께 저장하고, 있으면 추첨 전 최종 안내·링크를 제공하지 않습니다.') },
  '/api/rounds/{roundId}/draw': { post: roundCommand('잠긴 회차의 나머지를 한 번 추첨', 'AUTH → 회차 조회 → 회차 생성자·버전·LOCKED 검사 → 단일 저장 SQL 3회로 처리합니다. 서버 난수로 각 지출의 서로 다른 균등 부담자에게 최소 단위 1을 배분하고 CUSTOM 지정 부담금은 유지합니다. 최종 분담·잔액·송금·finalizedAt·버전·멱등 응답을 한 SQL로 원자적으로 저장해 정산 안내를 준비합니다. 명시적 BEGIN/COMMIT·공통 advisory lock 없이 저장 SQL 안에서 해당 회차 행만 잠그며, 이미 저장했다면 다른 키여도 다시 추첨하지 않습니다.') },
  '/api/rounds/{roundId}/complete': { post: roundCommand('모든 송금 수취 확인 후 정산 종료', 'AUTH → 미확인 수취 검사와 조건부 종료를 합친 단일 SQL의 총 2회이며 명시적 트랜잭션·락은 없습니다. 종료 UPDATE 안에서 미확인 수취가 없는지 검사하며, 남으면 저장하지 않고 409 pending_settlement_checks로 거절합니다. 회차 생성자만 최종 금액이 저장된 LOCKED 회차에서 모든 송금 건의 수취가 확인된 경우 COMPLETED로 바꿉니다. 상태·종료 시각·버전 증가·멱등 성공 기록을 한 SQL로 저장하고 같은 키/본문은 기존 결과를 재생합니다. 거절·성공 재생도 총 2회입니다. 송금 건이 없으면 별도 확인 없이 종료할 수 있습니다. 완료 데이터는 누구도 수정할 수 없고 해당 회차의 탈퇴 차단을 해제합니다.') },
  '/api/rounds/{roundId}/force-complete': { post: roundCommand('정산 강제 종료', '회차 생성자만 최종 금액이 저장된 LOCKED 회차를 수취 확인과 무관하게 COMPLETED로 바꿉니다. 미확인 송금 건은 null로 보존하며 완료 후 누구도 확인이나 정산 데이터를 변경할 수 없습니다.') },
  '/api/rounds/{roundId}/settlement-check': { post: operation('정산', '본인의 송금 건별 수취 확인 설정', { mutation: true, request: settlementCheckBody, description: '최종 금액이 저장된 LOCKED 회차에서 수취인 본인만 확인을 설정하거나 해제합니다. senderId와 currency를 지정하면 해당 송금자의 해당 통화 건만, 생략하면 본인의 수취 건 중 확인 상태가 다른 건을 변경합니다. AUTH → 수취 목록/권한 조회 → 단일 조건부 UPDATE의 SQL 3회이며 명시적 트랜잭션·락·멱등 성공 기록은 없습니다. 이미 요청한 확인 상태라 변경할 기록이 없으면 같은 키·새 키 모두 404 not_found입니다. 원본 잔액은 보존하고 확인 시각으로 남은 금액을 계산하며 회차 version은 올리지 않습니다. 완료 후에는 변경할 수 없습니다.' }) },
  '/api/rounds/{roundId}/settlement': { get: operation('정산', '본인의 개인 지급·수취 안내', { response: ref('Settlement'), description: '최종 저장 전에는 대기 상태만 반환합니다. 최종 금액은 고정하며 KRW에서는 본인이 지급할 수취인의 최신 계좌만 조회합니다. 지급·수취 상대의 이름과 활성 회원의 최신 카카오 프로필 이미지를 반환하고 탈퇴자의 이미지는 null로 반환합니다. 각 수취 건의 확인 시각과 수취인별 전체 완료 상태를 반환하며, 강제 종료 뒤에도 미확인 건은 null로 보존합니다. KRW 이외 통화와 수취 내역에는 계좌 필드가 없습니다. 모임·회차 생성자도 같은 공개 범위이며 링크는 로그인한 본인의 정보만 보여 줍니다.' }) },
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
    description: '카카오 인증·계좌·모임·회차·증빙·개인 정산 API. localStorage의 10분 Access JWT를 Bearer 헤더로 전송하고 Refresh JWT는 HttpOnly 쿠키로 유지합니다. 모임 생성은 UUIDv7 PK로 중복을 거절하며 다른 변경은 origin·권한·멱등 키를 검증합니다. 금액은 정확한 문자열이고 양수 잔액은 보낼 돈, 음수는 받을 돈입니다.',
  },
  servers: [{ url: '/', description: '현재 배포 주소' }],
  tags: [{ name: '상태' }, { name: '인증', description: '카카오 로그인과 토큰 관리' }, { name: '계정' }, { name: '모임' }, { name: '지출' }, { name: '정산' }],
  paths: {
    ...documentedDomainPaths,
    '/api/health/live': { get: healthOperation('애플리케이션 응답 확인', ['application']) },
    '/api/health/database': { get: healthOperation('PostgreSQL 연결 확인', ['database']) },
    '/api/health/minio': { get: healthOperation('MinIO 저장소 읽기·쓰기 상태 확인', ['minio']) },
    '/api/health/dependencies': { get: healthOperation('PostgreSQL·MinIO 저장소 읽기·쓰기 상태 확인', ['database', 'minio']) },
    '/api/health': { get: healthOperation('전체 상태 확인', ['application', 'database', 'minio']) },
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
        description: '인가 코드를 교환하고 OIDC sub를 검증합니다. 가입 완료 활성 회원은 app JWT, 신규·가입 미완료·탈퇴 회원은 10분 onboarding JWT를 발급합니다. 로그인만으로 재가입하지 않습니다.',
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
    '/api/auth/access-token': { post: {
      tags: ['인증'], summary: '로그인 완료 후 Access JWT 전달',
      description: 'Refresh JWT의 서명·만료를 확인해 app/onboarding 목적을 보존한 Access JWT를 JSON으로 전달합니다. 브라우저가 localStorage에 저장하며 URL·Access 쿠키에 토큰을 넣지 않습니다.',
      security: [{ refreshCookie: [] }], parameters: [mutationParameters[0]],
      responses: { '200': { description: 'data.accessToken과 data.purpose 반환' }, '401': { $ref: '#/components/responses/Unauthorized' }, '403': { $ref: '#/components/responses/Forbidden' }, '503': { $ref: '#/components/responses/DomainFailure' } },
    } },
    '/api/auth/refresh': {
      post: {
        tags: ['인증'],
        summary: '액세스 토큰 재발급',
        description: 'Node JWT Guard에서 리프레시 JWT의 서명·만료를 먼저 검증합니다. DB 세션 없이 JWT의 목적을 보존해 Access JWT를 JSON으로 반환하고 Refresh 쿠키를 갱신합니다. app Refresh는 14일로 갱신하고 onboarding Refresh의 원래 만료 시각은 연장하지 않습니다. 이전 Refresh JWT도 자체 만료까지 유효합니다.',
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
          '200': { description: 'data.accessToken을 반환하고 Refresh 쿠키 갱신' },
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
        description: 'Node JWT Guard에서 유효한 Refresh 또는 Bearer Access JWT를 요구합니다. 브라우저는 성공 후 localStorage의 Access 토큰을 삭제하고 서버는 Refresh 쿠키를 삭제합니다. DB 세션을 사용하거나 Access JWT를 즉시 만료시키지 않으며 발급 후 10분까지 유효합니다.',
        parameters: [
          {
            name: 'Origin',
            in: 'header',
            required: true,
            schema: { type: 'string', format: 'uri' },
            description: '현재 서비스 origin과 정확히 일치해야 합니다.',
          },
        ],
        security: [{ refreshCookie: [] }, { accessBearer: [] }],
        responses: {
          '200': { $ref: '#/components/responses/Ok' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },
    '/api/auth/withdraw': {
      post: {
        tags: ['인증'],
        summary: '회원 탈퇴',
        description: 'BEGIN → advisory transaction lock 획득 → AUTH → 미종료 참여 회차 조회 → 조건부 소프트 삭제·모임 이탈 단일 SQL → COMMIT의 6회입니다. 모임 탈퇴와 같은 락을 사용하며 성공 시 COMMIT, 실패 시 ROLLBACK으로 락을 자동 해제합니다. 참여 이력이 있는 미종료 회차가 있으면 제외 여부와 무관하게 409 unfinished_rounds로 차단합니다. deletedAt과 활성 멤버십 종료를 원자적으로 저장하고 클라이언트 토큰·쿠키를 삭제합니다. 동일 카카오 재가입 시 같은 ID·과거 기록을 유지하고 이전 모임·관리 권한은 복원하지 않습니다.',
        parameters: [
          {
            name: 'Origin',
            in: 'header',
            required: true,
            schema: { type: 'string', format: 'uri' },
            description: '현재 서비스 origin과 정확히 일치해야 합니다.',
          },
        ],
        security: [{ accessBearer: [] }],
        responses: {
          '200': { description: '탈퇴 완료', content: { 'application/json': { schema: object({ ok: { type: 'boolean' } }, ['ok']) } } },
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
      accessBearer: {
        type: 'http', scheme: 'bearer', bearerFormat: 'JWT',
        description: 'localStorage에 저장하는 10분 Access JWT. DB 세션 유효성을 확인하지 않으며 회원 상태·리소스 권한은 검사합니다.',
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
      RefreshUnavailable: {
        description: '액세스 토큰 재발급 실패. 인증 설정·일시적 서버 오류 확인 후 재시도',
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
