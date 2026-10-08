import type { INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
  type OperationObject,
} from '@nestjs/swagger';
import { openApiDocument } from '../util/openapi';

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
          if (url.origin === browser.location.origin && url.pathname === '/api/openapi.json') {
            let token = browser.localStorage.getItem('da_moa_access');
            const bootstrap = await fetch('/api/auth/access-token', {
              method: 'POST',
              credentials: 'same-origin',
            });
            if (bootstrap.ok) {
              const result = await bootstrap.json() as { data?: { accessToken?: string } };
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

// Keep the documented auth/SQL/response contracts; derive request schemas from the actual DTOs.
export function configureRequestSchemas(app: INestApplication) {
  const generated = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('다모아 API').setVersion('2.0.0').build(),
  );
  const document = openApiDocument as unknown as OpenAPIObject;
  Object.assign(document.components!.schemas!, generated.components?.schemas);
  for (const [path, operations] of Object.entries(generated.paths)) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
      const request = operations[method] as OperationObject | undefined;
      const existing = document.paths[path]?.[method];
      if (!request || !existing) continue;
      if (request.requestBody) existing.requestBody = request.requestBody;
      for (const parameter of request.parameters ?? []) {
        if ('$ref' in parameter || parameter.in !== 'query') continue;
        const index =
          existing.parameters?.findIndex(
            (value) =>
              !('$ref' in value) &&
              value.in === 'query' &&
              value.name === parameter.name,
          ) ?? -1;
        if (index >= 0)
          existing.parameters![index] = {
            ...existing.parameters![index],
            ...parameter,
          };
        else (existing.parameters ??= []).push(parameter);
      }
    }
  }
}
