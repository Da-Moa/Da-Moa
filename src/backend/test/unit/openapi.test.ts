import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { CURRENCY_CODES } from '../../../shared/domain/settle/money.ts';
import {
  createMockBackend,
  mockFetch,
  mockOrigin,
} from '../support/mockHttpTestSupport';
import { OpenApiService } from '../../global/apiPayload/openApi.service';
import { TokenService } from '../../global/auth/service/token.service';

const { app } = await createMockBackend();
after(() => app.close());
const actualDocument = app.get(OpenApiService).getDocument();
// Assertions inspect the resolved JSON contract regardless of whether Swagger
// emits a named DTO reference or the previous inline schema.
function expand(value: unknown): any {
  if (Array.isArray(value)) return value.map(expand);
  if (!value || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  if (
    typeof object.$ref === 'string' &&
    object.$ref.startsWith('#/components/schemas/')
  ) {
    const name = object.$ref.split('/').at(-1)!;
    const { $ref, ...options } = object;
    return expand({ ...actualDocument.components!.schemas![name], ...options });
  }
  return Object.fromEntries(
    Object.entries(object).map(([key, child]) => [key, expand(child)]),
  );
}
const openApiDocument = expand(actualDocument);

test('다른 Nest 앱의 문서 변경·종료와 무관하게 OpenAPI 문서의 인증과 독립성을 유지한다', async (t) => {
  const previous = process.env.AUTH_JWT_SECRET;
  process.env.AUTH_JWT_SECRET =
    'isolated-document-test-secret-at-least-32-bytes';
  const { app: other } = await createMockBackend();
  t.after(async () => {
    await other.close();
    if (previous === undefined) delete process.env.AUTH_JWT_SECRET;
    else process.env.AUTH_JWT_SECRET = previous;
  });
  const second = other.get(OpenApiService).getDocument();
  assert.notEqual(actualDocument, second);
  assert.notEqual(
    actualDocument.components!.schemas!.Me,
    second.components!.schemas!.Me,
  );
  second.info.title = 'another app';
  second.components!.schemas!.Me = { type: 'string' };

  const origin = mockOrigin(app);
  const get = (token?: string) =>
    mockFetch(app)(`${origin}/api/openapi.json`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
  const denied = await get();
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get('cache-control'), 'private, no-store');
  assert.equal((await denied.json()).error, 'unauthorized');
  const token = app
    .get(TokenService)
    .createAccessToken('document-user', 'document-session');
  for (const closed of [false, true]) {
    if (closed) await other.close();
    const response = await get(token);
    assert.equal(response.status, 200);
    const served = await response.json();
    assert.deepEqual(served, actualDocument);
    const me = served.components!.schemas!.Me;
    assert.ok(!('$ref' in me));
    assert.equal(me.type, 'object');
    const operations = Object.values(
      served.paths as Record<string, Record<string, unknown>>,
    ).flatMap((item) =>
      Object.keys(item).filter((key) =>
        ['get', 'post', 'put', 'patch', 'delete'].includes(key),
      ),
    );
    assert.equal(operations.length, 45);
    assert.equal(served.paths['/api/openapi.json'], undefined);
    assert.equal(served.paths['/api/auth/test-login'], undefined);
  }
});

test('OpenAPI 문서가 Swagger UI와 호환되는 3.0 형식을 사용한다', () => {
  assert.equal(openApiDocument.openapi, '3.0.3');
  assert.equal(JSON.stringify(openApiDocument).includes('"const"'), false);
});

test('OpenAPI 문서에 복구 가능한 토큰 갱신 실패를 명시한다', () => {
  const refresh = openApiDocument.paths['/api/auth/refresh'].post;

  const failure = refresh.responses['503'].content['application/json'];
  assert.deepEqual(failure.schema.properties.error.enum, [
    'refresh_unavailable',
  ]);
  assert.equal(failure.example.error, 'refresh_unavailable');
  assert.ok(failure.schema.required.includes('message'));
  assert.deepEqual(
    refresh.responses['401'].content['application/json'].schema.required,
    ['error'],
  );
  assert.match(
    openApiDocument.paths['/api/auth/logout'].post.description,
    /DB 세션을 사용하거나 Access JWT를 즉시 만료시키지/,
  );
  assert.deepEqual(openApiDocument.paths['/api/auth/logout'].post.security, [
    { refreshCookie: [] },
    { accessBearer: [] },
  ]);
  assert.ok(openApiDocument.paths['/api/auth/logout'].post.responses['401']);
});

type DocumentedOperation = {
  parameters?: Array<{
    name: string;
    in: string;
    required?: boolean;
    description?: string;
    schema?: { pattern?: string; format?: string };
  }>;
  requestBody?: {
    content: Record<string, { schema: { required?: string[] } }>;
  };
  responses: Record<string, unknown>;
  description: string;
};
type DocumentedSchema = {
  required?: string[];
  properties?: Record<string, DocumentedSchema>;
  enum?: string[];
  format?: string;
  nullable?: boolean;
  additionalProperties?: boolean;
  maxItems?: number;
  items?: DocumentedSchema;
  description?: string;
};
const paths = openApiDocument.paths as unknown as Record<
  string,
  Record<string, DocumentedOperation> & {
    parameters?: Array<{
      name: string;
      in: string;
      required?: boolean;
      description?: string;
      schema?: { pattern?: string; format?: string };
    }>;
  }
>;

test('모임 생성에는 UUIDv7 키를 요구하고 토큰 발급에는 Origin만 요구한다', () => {
  const parameters = paths['/api/groups'].post.parameters ?? [];
  const key = parameters.find(
    (parameter) => parameter.name === 'Idempotency-Key',
  );
  assert.equal(key?.schema?.format, 'uuid');
  assert.match(key?.description ?? '', /UUIDv7/);
  assert.equal(
    parameters.find((parameter) => parameter.name === 'Origin')?.schema?.format,
    'uri',
  );
  assert.deepEqual(
    openApiDocument.paths['/api/auth/access-token'].post.parameters.map(
      (parameter: { name: string }) => parameter.name,
    ),
    ['Origin'],
  );
});

test('모든 모임·지출·정산 API에 인증·변경 요청 계약을 문서화한다', () => {
  const mutations = [
    ['/api/groups', 'post'],
    ['/api/groups/{groupId}', 'delete'],
    ['/api/groups/{groupId}/rounds', 'post'],
    ['/api/groups/{groupId}/invites', 'post'],
    ['/api/groups/{groupId}/invites/{inviteId}', 'delete'],
    ['/api/invites/{token}/accept', 'post'],
    ['/api/me/bank-account', 'put'],
    ['/api/rounds/{roundId}/expenses', 'post'],
    ['/api/rounds/{roundId}/expenses/{expenseId}', 'patch'],
    ['/api/rounds/{roundId}/expenses/{expenseId}', 'delete'],
    ['/api/rounds/{roundId}/expenses/{expenseId}/receipts', 'post'],
    [
      '/api/rounds/{roundId}/expenses/{expenseId}/receipts/{receiptId}',
      'delete',
    ],
    ['/api/rounds/{roundId}/members/{userId}/exclude', 'post'],
    ['/api/rounds/{roundId}/settlement-check', 'post'],
    ...['confirm', 'reopen', 'send', 'draw', 'complete', 'force-complete'].map(
      (command) => [`/api/rounds/{roundId}/${command}`, 'post'],
    ),
    ['/api/rounds/{roundId}', 'delete'],
  ];
  for (const [path, method] of mutations) {
    const operation = paths[path]?.[method];
    assert.ok(operation, `${method} ${path}`);
    assert.ok(
      operation.parameters?.some(
        (parameter) =>
          parameter.name === 'Idempotency-Key' && parameter.required,
      ),
      path,
    );
    assert.ok(
      operation.parameters?.some(
        (parameter) => parameter.name === 'Origin' && parameter.required,
      ),
      path,
    );
    assert.ok(operation.responses['409'], path);
    assert.ok(operation.responses['503'], path);
    if (path.startsWith('/api/rounds/')) {
      const content = operation.requestBody?.content;
      const schema =
        content?.['application/json']?.schema ??
        content?.['multipart/form-data']?.schema;
      assert.ok(schema?.required?.includes('expectedVersion'), path);
    }
  }
  for (const [path, item] of Object.entries(paths)) {
    for (const [, name] of path.matchAll(/\{([^}]+)\}/g)) {
      assert.ok(
        item.parameters?.some(
          (parameter) =>
            parameter.name === name &&
            parameter.in === 'path' &&
            parameter.required,
        ) ||
          Object.values(item).some(
            (operation) =>
              !Array.isArray(operation) &&
              operation.parameters?.some(
                (parameter) =>
                  parameter.name === name &&
                  parameter.in === 'path' &&
                  parameter.required,
              ),
          ),
        `${path}: ${name}`,
      );
    }
  }
});

test('OpenAPI 스키마 참조를 해석하고 금융 개인정보 규칙을 명시한다', () => {
  const document = actualDocument as unknown as Record<string, unknown>;
  function check(value: unknown, name?: string) {
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.required))
      assert.ok(
        record.required.length,
        'OpenAPI required arrays must not be empty',
      );
    if (['createdAt', 'updatedAt', 'expiresAt'].includes(name ?? '')) {
      assert.equal(record.format, 'int64', `${name} must be a timestamp`);
      assert.notEqual(record.nullable, true, `${name} must not be nullable`);
    }
    if (typeof record.$ref === 'string') {
      assert.ok(record.$ref.startsWith('#/'), record.$ref);
      let target: unknown = document;
      for (const segment of record.$ref.slice(2).split('/'))
        target = (target as Record<string, unknown>)?.[segment];
      assert.ok(target, record.$ref);
    }
    for (const [key, child] of Object.entries(record)) check(child, key);
  }
  check(document);
  assert.match(
    paths['/api/rounds/{roundId}/settlement'].get.description,
    /본인이 지급할 수취인의 최신 계좌/,
  );
  assert.match(
    paths['/api/rounds/{roundId}/settlement'].get.description,
    /KRW 이외 통화와 수취 내역에는 계좌 필드가 없습니다/,
  );
  assert.match(
    paths['/api/rounds/{roundId}/settlement'].get.description,
    /각 수취 건의 확인 시각/,
  );
  assert.ok(
    (
      openApiDocument.components.schemas.Settlement as DocumentedSchema
    ).required?.includes('confirmations'),
  );
  assert.deepEqual(
    (
      openApiDocument.components.schemas
        .SettlementConfirmation as DocumentedSchema
    ).required,
    ['userId', 'displayName', 'profileImageUrl', 'checkedAt'],
  );
  assert.ok(
    (
      openApiDocument.components.schemas.IncomingTransfer as DocumentedSchema
    ).required?.includes('receivedAt'),
  );
  const checkInput = paths['/api/rounds/{roundId}/settlement-check'].post
    .requestBody!.content['application/json'].schema as DocumentedSchema;
  assert.deepEqual(checkInput.required, ['expectedVersion', 'checked']);
  assert.ok(checkInput.properties?.senderId);
  assert.match(paths['/api/auth/withdraw'].post.description, /deletedAt/);
  assert.match(
    paths['/api/rounds/{roundId}/send'].post.description,
    /실제 메시지를 전송하지 않습니다/,
  );
  assert.equal(
    openApiDocument.components.schemas.Expense.properties.amountMinor.type,
    'string',
  );
  assert.deepEqual(
    openApiDocument.components.schemas.Currency.enum,
    CURRENCY_CODES,
  );
});

test('지출에는 통화를 요구하고 회차 생성·모임·초대 미리보기에는 통화를 포함하지 않는다', () => {
  const groupInput = paths['/api/groups'].post.requestBody!.content[
    'application/json'
  ].schema as DocumentedSchema;
  assert.deepEqual(groupInput.required, ['name']);
  assert.deepEqual(Object.keys(groupInput.properties!), ['name']);
  assert.equal(groupInput.additionalProperties, false);

  const roundInput = paths['/api/groups/{groupId}/rounds'].post.requestBody!
    .content['application/json'].schema as DocumentedSchema;
  assert.deepEqual(roundInput.required, ['name', 'participantIds']);
  assert.equal('currency' in roundInput.properties!, false);
  const expenseInput = paths['/api/rounds/{roundId}/expenses'].post.requestBody!
    .content['application/json'].schema as DocumentedSchema;
  assert.ok(expenseInput.required?.includes('currency'));
  assert.deepEqual(expenseInput.properties!.currency.enum, CURRENCY_CODES);
  assert.equal(roundInput.additionalProperties, false);
  assert.match(
    paths['/api/groups/{groupId}/rounds'].post.description,
    /각 지출에서 지원 통화를 선택/,
  );
  assert.match(
    paths['/api/groups/{groupId}/rounds'].post.description,
    /한 회차에 최대 5개 통화/,
  );

  for (const name of ['Group', 'GroupDetail'] as const) {
    const schema = openApiDocument.components.schemas[name] as DocumentedSchema;
    assert.equal('currency' in schema.properties!, false);
  }
  const preview = paths['/api/invites/{token}'].get.responses['200'] as {
    content: Record<string, { schema: DocumentedSchema }>;
  };
  assert.equal(
    'currency' in
      preview.content['application/json'].schema.properties!.data.properties!,
    false,
  );
  assert.equal(
    (openApiDocument.components.schemas.GroupDetail as DocumentedSchema)
      .properties!.members.maxItems,
    10,
  );
  assert.equal('/api/groups/{groupId}/members' in paths, false);
  assert.equal(roundInput.properties!.participantIds.maxItems, 10);
  assert.match(
    paths['/api/invites/{token}/accept'].post.description,
    /group_member_limit_exceeded/,
  );
  const round = openApiDocument.components.schemas.Round as DocumentedSchema;
  assert.equal('currency' in round.properties!, false);
  assert.equal(round.properties!.totals.maxItems, 5);
});

test('회차 목록에 모임명·회차명 검색을 문서화한다', () => {
  for (const path of ['/api/rounds', '/api/groups/{groupId}/rounds']) {
    const search = paths[path].get.parameters?.find(
      (parameter) => parameter.name === 'q',
    ) as { schema?: { minLength?: number; maxLength?: number } } | undefined;
    assert.deepEqual(search?.schema, {
      type: 'string',
      minLength: 1,
      maxLength: 100,
    });
  }
});

test('모임 목록에 이름 검색과 커서 페이지 조회를 문서화한다', () => {
  const parameters = paths['/api/groups'].get.parameters ?? [];
  const search = parameters.find((parameter) => parameter.name === 'q') as
    { schema?: { minLength?: number; maxLength?: number } } | undefined;
  assert.deepEqual(search?.schema, {
    type: 'string',
    minLength: 1,
    maxLength: 100,
  });
  assert.match(
    parameters.find((parameter) => parameter.name === 'cursor')?.description ??
      '',
    /모임 ID 내림차순/,
  );
  const listItem = openApiDocument.components.schemas
    .GroupListItem as DocumentedSchema;
  assert.ok(listItem.required?.includes('memberCount'));
  assert.equal(listItem.properties?.memberPreview.maxItems, 5);
  assert.ok(
    listItem.properties?.memberPreview.items?.properties?.profileImageUrl,
  );
});

test('개별 지출 분배에 원래 분담액과 합계 검증을 문서화한다', () => {
  for (const [path, method] of [
    ['/api/rounds/{roundId}/expenses', 'post'],
    ['/api/rounds/{roundId}/expenses/{expenseId}', 'patch'],
  ]) {
    const input = paths[path][method].requestBody!.content['application/json']
      .schema as DocumentedSchema;
    assert.deepEqual(input.properties!.splitMode.enum, [
      'ALL',
      'SELECTED',
      'CUSTOM',
    ]);
    assert.deepEqual(input.properties!.customShares.items!.required, [
      'userId',
      'amount',
    ]);
    assert.match(
      input.properties!.customShares.description!,
      /합계는 총 amount와 같아야/,
    );
    assert.match(
      input.properties!.participantIds.description!,
      /CUSTOM에서는 보내지/,
    );
  }
  assert.match(
    paths['/api/rounds/{roundId}/expenses'].post.description,
    /400 custom_share_total_mismatch/,
  );
  assert.match(
    paths['/api/rounds/{roundId}/expenses/{expenseId}'].patch.description,
    /customShares를 생략하면 원본 부담금을 유지/,
  );
  const share = (openApiDocument.components.schemas.Expense as DocumentedSchema)
    .properties!.shares.items!;
  assert.ok(share.required!.includes('assignedAmountMinor'));
  assert.equal(share.properties!.assignedAmountMinor.nullable, true);
  assert.equal(share.properties!.amountMinor.nullable, true);
  assert.match(
    share.properties!.amountMinor.description!,
    /최종화 전에는 CUSTOM도 null/,
  );
});

test('문서의 최소 화폐 단위 금액은 정수 문자열만 허용하고 소수를 거부한다', () => {
  const schemas = openApiDocument.components.schemas;
  const amount = new RegExp(schemas.Expense.properties.amountMinor.pattern);
  const balance = new RegExp(
    schemas.CurrencyBalance.properties.balanceMinor.pattern,
  );
  assert.equal(amount.test('123'), true);
  assert.equal(amount.test('0'), true);
  assert.equal(amount.test('-1'), false);
  assert.equal(amount.test('1.25'), false);
  assert.equal(balance.test('-123'), true);
  assert.equal(balance.test('123'), true);
  assert.equal(balance.test('1.25'), false);
});
