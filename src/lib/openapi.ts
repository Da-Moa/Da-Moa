export const openApiDocument = {
  // ponytail: keep Swagger UI on its Turbopack-safe resolver; use a static bundle before adopting OpenAPI 3.1-only schemas.
  openapi: '3.0.3',
  info: {
    title: '다모아 API',
    version: '1.0.0',
    description: '다모아의 카카오 OIDC 로그인과 세션 관리 API입니다. 인증은 HttpOnly 쿠키로 처리합니다.',
  },
  servers: [{ url: '/', description: '현재 배포 주소' }],
  tags: [{ name: '인증', description: '카카오 로그인과 토큰 관리' }],
  paths: {
    '/api/auth/kakao': {
      get: {
        tags: ['인증'],
        summary: '카카오 로그인 시작',
        description: 'OIDC state·nonce·PKCE 쿠키를 설정한 뒤 카카오 인증 화면으로 이동합니다.',
        responses: {
          '307': { description: '카카오 인증 화면 또는 로그인 오류 화면으로 이동' },
        },
      },
    },
    '/auth/v1/kakao': {
      get: {
        tags: ['인증'],
        summary: '카카오 로그인 콜백',
        description: '인가 코드를 토큰으로 교환하고 ID 토큰을 검증합니다. 사용자를 생성 또는 갱신한 뒤 액세스·리프레시 쿠키를 설정합니다.',
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
          '307': { description: '성공 시 /home, 실패 시 /login으로 이동' },
        },
      },
    },
    '/api/auth/refresh': {
      post: {
        tags: ['인증'],
        summary: '액세스 토큰 재발급',
        description: '서명과 만료가 유효하고 DB에 저장된 해시와 일치하는 리프레시 토큰이 있을 때만 액세스·리프레시 JWT를 함께 회전해 설정합니다.',
        parameters: [
          {
            name: 'Origin',
            in: 'header',
            required: false,
            schema: { type: 'string', format: 'uri' },
            description: '전달하면 현재 서비스 origin과 정확히 일치해야 합니다.',
          },
        ],
        security: [{ refreshCookie: [] }],
        responses: {
          '200': { $ref: '#/components/responses/Ok' },
          '401': { $ref: '#/components/responses/Unauthorized' },
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
            required: false,
            schema: { type: 'string', format: 'uri' },
            description: '전달하면 현재 서비스 origin과 정확히 일치해야 합니다.',
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
        description: '다모아에 저장된 사용자와 연결된 리프레시 토큰을 삭제합니다. 카카오 계정 자체는 삭제하지 않습니다.',
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
          '200': { $ref: '#/components/responses/Ok' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '503': { $ref: '#/components/responses/WithdrawalUnavailable' },
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
        description: '5분 수명의 HttpOnly 액세스 JWT',
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
        properties: { error: { type: 'string', enum: ['unauthorized'] } },
      },
      Forbidden: {
        type: 'object',
        additionalProperties: false,
        required: ['error'],
        properties: { error: { type: 'string', enum: ['forbidden'] } },
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
      WithdrawalUnavailable: {
        type: 'object',
        additionalProperties: false,
        required: ['error'],
        properties: { error: { type: 'string', enum: ['withdrawal_unavailable'] } },
      },
    },
    responses: {
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
        description: 'Origin 검증 실패',
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
      WithdrawalUnavailable: {
        description: '회원 탈퇴 처리 중 DB를 사용할 수 없음',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/WithdrawalUnavailable' },
            example: { error: 'withdrawal_unavailable' },
          },
        },
      },
    },
  },
} as const
