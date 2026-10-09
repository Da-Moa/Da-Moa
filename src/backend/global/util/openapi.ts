import { CURRENCY_CODES } from '../../../shared/domain/settle/money'

type Schema = Record<string, unknown>
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: 'object', properties, ...(required.length ? { required } : {}) })
const success = (data: Schema): Schema => object({ data, meta: object({ code: string, message: string, detail: { type: 'object', nullable: true, additionalProperties: true } }, ['code', 'message', 'detail']) }, ['data', 'meta'])
const string: Schema = { type: 'string' }
const minor: Schema = { type: 'string', pattern: '^\\d+$', description: '통화 최소 단위의 정확한 정수 문자열. KRW·JPY·VND는 주 단위, 나머지 지원 통화는 주 단위의 1/100.' }
const currency: Schema = { type: 'string', enum: CURRENCY_CODES }
const status: Schema = { type: 'string', enum: ['RECORDING', 'CONFIRMED', 'LOCKED', 'COMPLETED'] }
const domainResponses = {
  RateLimited: {
    description: '전체 또는 사용자별 요청량 제한. Retry-After 초 뒤 재시도하며 저장 요청의 기존 Idempotency-Key와 본문을 유지합니다.',
    headers: { 'Retry-After': { description: '다음 요청까지 대기할 초', schema: { type: 'integer', minimum: 1 } } },
    content: { 'application/json': { schema: ref('ApiError'), example: { error: 'rate_limited', message: '요청이 많아요. 2초 후 다시 시도해 주세요.', details: { retryAfterSeconds: 2 } } } },
  },
  DomainFailure: {
    description: '요청 오류. 409는 상태·버전·제외·인원 제한·미종료 회차·멱등 키 충돌, 503은 같은 키로 재시도할 저장소·외부 서비스 오류입니다.',
    content: { 'application/json': { schema: ref('ApiError') } },
  },
}

const domainSchemas = { Currency: currency, RoundStatus: status, MinorAmount: minor }
const healthCheck: Schema = { type: 'string', enum: ['ok', 'down'] }
function healthOperation(summary: string, names: string[]) {
  const dependencyCheck = names.some(name => name !== 'application')
  const checks = object(Object.fromEntries(names.map(name => [name, name === 'application' ? { type: 'string', enum: ['ok'] } : healthCheck])), names)
  const response = { content: { 'application/json': { schema: object({ status: dependencyCheck ? healthCheck : { type: 'string', enum: ['ok'] }, checks }, ['status', 'checks']) } } }
  return { tags: ['상태'], summary, description: '인증 없이 조회합니다. 결과를 캐시하지 않으며 내부 오류·연결 정보는 반환하지 않습니다.', security: [], responses: { '200': { description: '모든 검사 정상', ...response }, ...(dependencyCheck ? { '503': { description: '하나 이상의 의존 서비스 장애', ...response } } : {}) } }
}

// Remaining domains are migrated to Controller metadata in separate units.
export const legacyOpenApiDocument = {
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
    '/api/health/live': { get: healthOperation('애플리케이션 응답 확인', ['application']) },
    '/api/health/database': { get: healthOperation('PostgreSQL 연결 확인', ['database']) },
    '/api/health/minio': { get: healthOperation('MinIO 저장소 읽기·쓰기 상태 확인', ['minio']) },
    '/api/health/dependencies': { get: healthOperation('PostgreSQL·MinIO 저장소 읽기·쓰기 상태 확인', ['database', 'minio']) },
    '/api/health/worker': { get: healthOperation('영수증 워커 실행 상태 확인', ['worker']) },
    '/api/health/worker/readyz': { get: healthOperation('영수증 워커 큐 조회·PostgreSQL·MinIO 처리 준비 상태 확인', ['worker', 'database', 'minio']) },
    '/api/health': { get: healthOperation('전체 상태 확인', ['application', 'database', 'minio']) },
    '/api/auth/kakao': {
      get: {
        tags: ['인증'],
        summary: '카카오 로그인 시작',
        description: 'OIDC state·nonce·PKCE 쿠키와 안전한 복귀 목적지를 설정한 뒤 카카오 인증 화면으로 이동합니다.',
        parameters: [{ name: 'returnTo', in: 'query', schema: { type: 'string' }, description: '허용된 /home, /invites, /settlements 내부 경로. 외부·인증 루프 경로는 /home으로 대체합니다.' }],
        responses: {
          '307': { description: '카카오 인증 화면 또는 로그인 오류 화면으로 이동' },
          '429': { $ref: '#/components/responses/RateLimited' },
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
      security: [{ refreshCookie: [] }], parameters: [{ name: 'Origin', in: 'header', required: true, schema: { type: 'string', format: 'uri' }, description: '현재 서비스 origin과 정확히 일치해야 합니다.' }],
      responses: { '200': { description: 'data.accessToken과 data.purpose 반환', content: { 'application/json': { schema: success(object({ accessToken: string, purpose: { type: 'string', enum: ['app', 'onboarding'] } }, ['accessToken', 'purpose'])) } } }, '401': { $ref: '#/components/responses/Unauthorized' }, '429': { $ref: '#/components/responses/RateLimited' }, '403': { $ref: '#/components/responses/Forbidden' }, '503': { $ref: '#/components/responses/DomainFailure' } },
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
          '200': { description: 'data.accessToken을 반환하고 Refresh 쿠키 갱신', content: { 'application/json': { schema: success(object({ accessToken: string }, ['accessToken'])) } } },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '429': { $ref: '#/components/responses/RateLimited' },
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
          '200': { description: '로그아웃 완료', content: { 'application/json': { schema: success(object({ ok: { type: 'boolean' } }, ['ok'])) } } },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '429': { $ref: '#/components/responses/RateLimited' },
          '403': { $ref: '#/components/responses/Forbidden' },
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
