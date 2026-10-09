import type { INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
  type ReferenceObject,
  type SchemaObject,
} from '@nestjs/swagger';
import { OpenApiService } from './openApi.service';
import { OIDC_COOKIE_NAMES, REFRESH_TOKEN_COOKIE_NAME } from '../auth/native';

function documentValidatedBodies(document: OpenAPIObject) {
  const seen = new Set<string>();
  const visit = (schema: SchemaObject | ReferenceObject) => {
    if ('$ref' in schema) {
      if (seen.has(schema.$ref)) return;
      seen.add(schema.$ref);
      const name = schema.$ref.split('/').at(-1)!;
      const model = document.components?.schemas?.[name];
      if (!model || '$ref' in model) return;
      // Swagger does not infer the global ValidationPipe's
      // forbidNonWhitelisted setting from property decorators.
      if (model.type === 'object' && model.properties)
        model.additionalProperties = false;
      visit(model);
      return;
    }
    if (schema.items) visit(schema.items);
    for (const property of Object.values(schema.properties ?? {}))
      visit(property);
  };
  for (const item of Object.values(document.paths))
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const body = item[method]?.requestBody;
      if (!body || '$ref' in body) continue;
      for (const content of Object.values(body.content))
        if (content.schema) visit(content.schema);
    }
}

export function configureSwaggerUi(app: INestApplication) {
  // The init asset is public; the actual document remains behind the Nest JWT guard.
  const placeholder: OpenAPIObject = {
    openapi: '3.0.0',
    info: { title: '다모아 API', version: '2.0.0' },
    paths: {},
  };
  for (const path of ['api/docs', 'docs']) {
    SwaggerModule.setup(path, app, placeholder, {
      raw: false,
      customSiteTitle: 'API 문서 | 다모아',
      swaggerOptions: {
        spec: null,
        url: '/api/openapi.json',
        docExpansion: 'list',
        supportedSubmitMethods: [],
        validatorUrl: null,
        requestInterceptor: async function authenticatedDocumentation(request: {
          url: string;
          headers: Record<string, string>;
        }) {
          const browser = globalThis as unknown as {
            location: { origin: string };
            localStorage: {
              getItem(key: string): string | null;
              setItem(key: string, value: string): void;
            };
          };
          const url = new URL(request.url, browser.location.origin);
          if (
            url.origin === browser.location.origin &&
            url.pathname === '/api/openapi.json'
          ) {
            let token = browser.localStorage.getItem('da_moa_access');
            const bootstrap = await fetch('/api/auth/access-token', {
              method: 'POST',
              credentials: 'same-origin',
            });
            if (bootstrap.ok) {
              const result = (await bootstrap.json()) as {
                data?: { accessToken?: string };
              };
              if (typeof result.data?.accessToken === 'string') {
                token = result.data.accessToken;
                browser.localStorage.setItem('da_moa_access', token);
              }
            }
            if (token) request.headers.Authorization = `Bearer ${token}`;
          }
          return request;
        },
      },
    });
  }
}

// Controllers and runtime DTOs own the API catalog and schemas.
export function configureOpenApi(app: INestApplication) {
  const metadata = new DocumentBuilder()
    .setOpenAPIVersion('3.0.3')
    .setTitle('다모아 API')
    .setVersion('2.0.0')
    .setDescription(
      '카카오 인증·계좌·모임·회차·증빙·개인 정산 API. localStorage의 10분 Access JWT를 Bearer 헤더로 전송하고 Refresh JWT는 HttpOnly 쿠키로 유지합니다. 모임 생성은 UUIDv7 PK로 중복을 거절하며 다른 변경은 origin·권한·멱등 키를 검증합니다. 금액은 정확한 문자열이고 양수 잔액은 보낼 돈, 음수는 받을 돈입니다.',
    )
    .addServer('/', '현재 배포 주소')
    .addTag('상태')
    .addTag('인증', '카카오 로그인과 토큰 관리')
    .addTag('계정')
    .addTag('모임')
    .addTag('지출')
    .addTag('정산')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'localStorage에 저장하는 10분 Access JWT. DB 세션 유효성을 확인하지 않으며 회원 상태·리소스 권한은 검사합니다.',
      },
      'accessBearer',
    )
    .addCookieAuth(
      REFRESH_TOKEN_COOKIE_NAME,
      {
        type: 'apiKey',
        in: 'cookie',
        description: '14일 수명의 HttpOnly 리프레시 JWT',
      },
      'refreshCookie',
    )
    .addCookieAuth(
      OIDC_COOKIE_NAMES.state,
      { type: 'apiKey', in: 'cookie' },
      'oidcStateCookie',
    )
    .addCookieAuth(
      OIDC_COOKIE_NAMES.nonce,
      { type: 'apiKey', in: 'cookie' },
      'oidcNonceCookie',
    )
    .addCookieAuth(
      OIDC_COOKIE_NAMES.codeVerifier,
      { type: 'apiKey', in: 'cookie' },
      'oidcVerifierCookie',
    )
    .build();
  const document = SwaggerModule.createDocument(app, metadata);
  documentValidatedBodies(document);
  app.get(OpenApiService).configure(document);
}
