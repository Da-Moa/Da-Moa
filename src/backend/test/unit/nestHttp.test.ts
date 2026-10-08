import assert from 'node:assert/strict';
import test from 'node:test';
import { request as nodeRequest } from 'node:http';
import { GroupService } from '../../domain/group/service/group.service';
import { SettleService } from '../../domain/settle/service/settle.service';
import { UserService } from '../../domain/user/service/user.service';
import {
  CreateGroupRequestDTO,
  GroupListQueryDTO,
} from '../../domain/group/dto/req/group.request.dto';
import {
  ExpenseRequestDTO,
  CreateExpenseRequestDTO,
  VersionRequestDTO,
} from '../../domain/settle/dto/req/settle.request.dto';
import {
  BankAccountRequestDTO,
  OnboardingRequestDTO,
} from '../../domain/user/dto/req/user.request.dto';
import { issueTokens } from '../../global/auth/service/authTokens';
import { createBackend } from '../../domain/main';
import {
  createAccessToken,
  createRefreshToken,
  REFRESH_TOKEN_COOKIE_NAME,
} from '../../global/auth/native';

test('Nest JSON parser preserves byte limits, UTF-8, object shape and native Body DTOs after authentication', async (t) => {
  const previous = process.env.AUTH_JWT_SECRET;
  process.env.AUTH_JWT_SECRET = 'native-json-test-secret-at-least-32-bytes';
  const { app } = await createBackend();
  t.after(async () => {
    await app.close();
    if (previous === undefined) delete process.env.AUTH_JWT_SECRET;
    else process.env.AUTH_JWT_SECRET = previous;
  });
  await app.listen(0, '127.0.0.1');
  const origin = await app.getUrl();
  const token = createAccessToken('json-user', 'json-session');
  let calls = 0;
  t.mock.method(
    app.get(GroupService),
    'createGroup',
    async (...[_user, _key, body]: Parameters<GroupService['createGroup']>) => {
      calls++;
      assert.ok(body instanceof CreateGroupRequestDTO);
      return { id: body.name };
    },
  );
  const headers = {
    origin,
    authorization: `Bearer ${token}`,
    'idempotency-key': 'json-test-key',
  };
  const post = (body: BodyInit, extra: Record<string, string> = {}) =>
    fetch(`${origin}/api/groups`, {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
      headers: { ...headers, ...extra },
      body,
    });
  const valid = await post('{"name":"first","name":"parsed"}', {
    'content-type': 'text/plain',
  });
  assert.equal(valid.status, 200);
  assert.equal(
    (await valid.json()).data.id,
    'parsed',
    'duplicate keys keep JSON.parse semantics',
  );
  for (const body of [
    '[]',
    'null',
    '123',
    '"text"',
    '{',
    '{}',
    '{"name":123}',
    '{"name":"ok","extra":true}',
  ]) {
    const invalid = await post(body, { 'content-type': 'application/json' });
    assert.equal(invalid.status, 400, body);
    assert.equal((await invalid.json()).error, 'invalid_input');
  }
  const invalidUtf8 = Buffer.concat([
    Buffer.from('{"name":"'),
    Buffer.from([0xc3, 0x28]),
    Buffer.from('"}'),
  ]);
  assert.equal((await post(invalidUtf8)).status, 400);
  assert.equal(
    (
      await post(Buffer.from('{"name":"utf16"}', 'utf16le'), {
        'content-type': 'application/json; charset=utf-16le',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(`${origin}/api/me/onboarding`, {
        method: 'POST',
        headers,
        body: ' '.repeat(16385) + '{}',
      })
    ).status,
    413,
    'account routes retain their 16 KiB limit',
  );
  const oversized = ' '.repeat(1024 * 1024 + 1) + '{}';
  assert.equal((await post(oversized)).status, 413);
  assert.equal(
    (
      await fetch(`${origin}/api/groups`, {
        method: 'POST',
        headers: { origin },
        body: oversized,
      })
    ).status,
    401,
    'unauthorized oversized JSON is rejected by the Guard first',
  );
  const streamed = await new Promise<number>((resolve, reject) => {
    const request = nodeRequest(
      `${origin}/api/groups`,
      { method: 'POST', headers },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode!));
      },
    );
    request.on('error', reject);
    request.setTimeout(10000, () =>
      request.destroy(new Error('Chunked JSON request timed out')),
    );
    for (let i = 0; i < 17; i++) request.write(' '.repeat(65536));
    request.end('{}');
  });
  assert.equal(
    streamed,
    413,
    'chunked bodies are bounded without Content-Length',
  );
  assert.equal(
    calls,
    1,
    'invalid or oversized requests never reach the domain service',
  );
});

test('Nest HTTP routes enforce JWT before body parsing, preserve cookies, and dispatch each domain', async (t) => {
  const previous = process.env.AUTH_JWT_SECRET;
  process.env.AUTH_JWT_SECRET =
    'isolated-nest-http-test-secret-at-least-32-bytes';
  const { app } = await createBackend();
  t.after(async () => {
    await app.close();
    if (previous === undefined) delete process.env.AUTH_JWT_SECRET;
    else process.env.AUTH_JWT_SECRET = previous;
  });
  await app.listen(0, '127.0.0.1');
  const origin = await app.getUrl();
  const token = createAccessToken('unit-user', 'unit-session');
  const request = (
    path: string,
    method = 'GET',
    body?: string,
    authenticated = false,
    extraHeaders: Record<string, string> = {},
  ) =>
    fetch(`${origin}${path}`, {
      method,
      headers: {
        origin,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'http-request-key',
        ...extraHeaders,
        ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
      },
      body,
    });
  const live = await request('/api/health/live');
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), {
    status: 'ok',
    checks: { application: 'ok' },
  });
  assert.equal(live.headers.get('Cache-Control'), 'no-store');
  for (const path of [
    '/api/groups',
    '/api/rounds/id/confirm',
    '/api/me/onboarding',
    '/api/unknown',
    '/api/openapi.json',
  ]) {
    assert.equal((await request(path, 'POST', '{invalid')).status, 401, path);
  }
  for (const path of [
    '/api/groups',
    '/api/groups/id/rounds',
    '/api/rounds/id/confirm',
    '/api/me/onboarding',
  ]) {
    const response = await request(path, 'POST', '{invalid', true);
    assert.equal(
      response.status,
      400,
      `${path}: ${await response.clone().text()}`,
    );
  }
  assert.equal(
    (await request('/api/unknown', 'GET', undefined, true)).status,
    404,
  );
  const openapi = await request('/api/openapi.json', 'GET', undefined, true);
  assert.equal(openapi.status, 200);
  const apiDocument = await openapi.json();
  assert.equal(apiDocument.openapi, '3.0.3');
  for (const path of ['/docs', '/api/docs']) {
    const ui = await request(path);
    assert.equal(ui.status, 200);
    assert.match(ui.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await ui.text(), /swagger-ui-bundle\.js/);
    const init = await request(`${path}/swagger-ui-init.js`);
    assert.equal(init.status, 200);
    const script = await init.text();
    assert.match(script, /\/api\/openapi\.json/);
    assert.match(script, /da_moa_access/);
    assert.doesNotMatch(script, /\/api\/groups|CreateGroupRequestDTO/);
    const asset = await request(`${path}/swagger-ui.css`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type') ?? '', /text\/css/);
  }
  for (const path of [
    '/docs-json',
    '/docs-yaml',
    '/api/docs-json',
    '/api/docs-yaml',
  ]) {
    assert.equal((await request(path, 'GET', undefined, true)).status, 404);
  }
  const groups = app.get(GroupService);
  let createCalls = 0;
  groups.createGroup = async (_access, _key, body) => {
    createCalls++;
    assert.equal(_access?.userId, 'unit-user');
    assert.equal(_access?.sessionId, 'unit-session');
    assert.equal(_key, 'http-request-key');
    assert.ok(body instanceof CreateGroupRequestDTO);
    assert.equal(body.name, 'DTO group');
    return { id: 'group-id' };
  };
  const created = await request(
    '/api/groups',
    'POST',
    '{"name":"DTO group"}',
    true,
    { 'Idempotency-Key': 'http-request-key' },
  );
  assert.equal(created.status, 200);
  assert.deepEqual(await created.json(), {
    data: { id: 'group-id' },
    meta: { code: 'group_ok', message: '모임 요청을 처리했어요', detail: null },
  });
  assert.equal(created.headers.get('Cache-Control'), 'private, no-store');
  for (const invalidToken of [
    `${token}invalid`,
    createAccessToken(
      'unit-user',
      'unit-session',
      undefined,
      Math.floor(Date.now() / 1000) - 10,
      1,
    ),
    createRefreshToken('unit-user', 'unit-session'),
  ]) {
    const invalid = await request('/api/groups', 'POST', '{invalid', false, {
      authorization: `Bearer ${invalidToken}`,
      'x-user-id': 'forged-user',
    });
    assert.equal(invalid.status, 401);
  }
  for (const body of ['{"name":123}', '{"name":"ok","unknown":true}', '{}']) {
    const invalid = await request('/api/groups', 'POST', body, true);
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, 'invalid_input');
  }
  assert.equal(
    createCalls,
    1,
    'invalid JWTs and bodies never reach the service',
  );
  groups.listGroups = async (_access, query) => {
    assert.equal(_access?.userId, 'unit-user');
    assert.ok(query instanceof GroupListQueryDTO);
    assert.equal(query.limit, 2);
    return { items: [], nextCursor: null };
  };
  const page = await request('/api/groups?limit=2', 'GET', undefined, true);
  assert.equal(page.status, 200);
  for (const limit of ['0', '101', '1.5', 'no'])
    assert.equal(
      (await request(`/api/groups?limit=${limit}`, 'GET', undefined, true))
        .status,
      400,
    );
  const schema = apiDocument.components.schemas.CreateGroupRequestDTO;
  assert.equal(schema.properties.name.maxLength, 100);
  assert.deepEqual(schema.required, ['name']);
  const settle = app.get(SettleService);
  settle.roundCommand = async (_access, _key, _id, _command, body) => {
    assert.equal(_access?.userId, 'unit-user');
    assert.ok(body instanceof VersionRequestDTO);
    assert.equal(body.expectedVersion, 7);
    return { id: 'round-id' };
  };
  settle.saveExpense = async (_access, _key, _id, body) => {
    assert.ok(body instanceof CreateExpenseRequestDTO);
    assert.equal(body.amount, '1000');
    return { id: 'expense-id' };
  };
  for (const [path, body] of [
    ['/api/rounds/id/confirm', '{"expectedVersion":7}'],
    [
      '/api/rounds/id/expenses',
      '{"currency":"KRW","description":"식사","amount":"1000","payerId":"unit-user","splitMode":"ALL","expectedVersion":7}',
    ],
  ]) {
    const response = await request(path, 'POST', body, true);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).meta.code, 'settle_ok');
  }
  const users = app.get(UserService);
  users.updateBankAccount = async (_access, _key, body) => {
    assert.equal(_access?.userId, 'unit-user');
    assert.ok(body instanceof BankAccountRequestDTO);
    assert.equal(body.accountNumber, '001234');
    return { id: 'unit-user', bankVersion: 2 };
  };
  const bank = await request(
    '/api/me/bank-account',
    'PUT',
    '{"bankCode":"004","accountNumber":"001234","accountHolder":"사용자","expectedBankVersion":1}',
    true,
  );
  assert.deepEqual(await bank.json(), {
    data: { id: 'unit-user', bankVersion: 2 },
    meta: {
      code: 'user_ok',
      message: '사용자 요청을 처리했어요',
      detail: null,
    },
  });
  users.completeOnboarding = async (_access, body) => {
    assert.ok(body instanceof OnboardingRequestDTO);
    return issueTokens('unit-user', 'app', Math.floor(Date.now() / 1000));
  };
  const onboarding = await request(
    '/api/me/onboarding',
    'POST',
    '{"bankCode":"004","accountNumber":"001234","accountHolder":"사용자","expectedBankVersion":1}',
    true,
  );
  assert.equal(onboarding.status, 200);
  assert.equal(onboarding.headers.getSetCookie().length, 3);
  assert.ok((await onboarding.json()).data.accessToken);
  assert.equal(
    (
      await request(
        '/api/me/bank-account',
        'PUT',
        JSON.stringify({ accountNumber: 'a'.repeat(16384) }),
        true,
      )
    ).status,
    413,
  );
  const foreignOrigin = await fetch(`${origin}/api/groups`, {
    method: 'POST',
    headers: {
      origin: 'https://foreign.example',
      authorization: `Bearer ${token}`,
    },
    body: '{invalid',
  });
  assert.equal(foreignOrigin.status, 403);
  const denied = await request('/api/auth/refresh', 'POST');
  assert.equal(denied.status, 401);
  assert.ok(denied.headers.getSetCookie().length >= 2);
  assert.ok(
    denied.headers.getSetCookie().every((value) => value.includes('Max-Age=0')),
  );
  const refresh = createRefreshToken('unit-user', 'unit-session');
  const refreshed = await fetch(`${origin}/api/auth/refresh`, {
    method: 'POST',
    headers: { origin, cookie: `${REFRESH_TOKEN_COOKIE_NAME}=${refresh}` },
  });
  assert.equal(refreshed.status, 200, await refreshed.clone().text());
  const refreshPayload = await refreshed.json();
  assert.ok(refreshPayload.data.accessToken);
  assert.equal(refreshPayload.meta.code, 'auth_ok');
  assert.equal(refreshed.headers.getSetCookie().length, 2);
  assert.equal(refreshed.headers.get('x-powered-by'), null);
  const loggedOut = await fetch(`${origin}/api/auth/logout`, {
    method: 'POST',
    headers: { origin, cookie: `${REFRESH_TOKEN_COOKIE_NAME}=${refresh}` },
    body: '{invalid',
  });
  assert.equal(
    loggedOut.status,
    200,
    'logout accepts a Refresh cookie without an Access header',
  );
  assert.ok(
    loggedOut.headers
      .getSetCookie()
      .every((cookie) => cookie.includes('Max-Age=0')),
  );
});

test('required idempotency headers reject absent and blank values before every mutation handler', async (t) => {
  const previous = process.env.AUTH_JWT_SECRET;
  process.env.AUTH_JWT_SECRET =
    'required-header-unit-test-secret-at-least-32-bytes';
  const { app } = await createBackend();
  t.after(async () => {
    await app.close();
    if (previous === undefined) delete process.env.AUTH_JWT_SECRET;
    else process.env.AUTH_JWT_SECRET = previous;
  });
  await app.listen(0, '127.0.0.1');
  const origin = await app.getUrl();
  const token = createAccessToken('unit-user', 'unit-session');
  const calls: unknown[][] = [];
  for (const [service, methods] of [
    [
      app.get(GroupService),
      [
        'createGroup',
        'leaveGroup',
        'createInvite',
        'revokeInvite',
        'acceptInvite',
      ],
    ],
    [
      app.get(SettleService),
      [
        'createRound',
        'roundCommand',
        'setSettlementCheck',
        'saveExpense',
        'deleteExpense',
        'excludeMember',
        'addReceipt',
        'removeReceipt',
      ],
    ],
    [app.get(UserService), ['updateBankAccount']],
  ] as const)
    for (const method of methods)
      t.mock.method(
        service,
        method as never,
        (async (...args: unknown[]) => {
          calls.push(args);
          return { id: 'created-id' };
        }) as never,
      );
  const version = { expectedVersion: 1 };
  const expense = {
    ...version,
    currency: 'KRW',
    description: '식사',
    amount: '1000',
    payerId: 'unit-user',
    splitMode: 'ALL',
  };
  const cases: [string, string, unknown?][] = [
    ['POST', '/api/groups', { name: '모임' }],
    ['DELETE', '/api/groups/g'],
    ['POST', '/api/groups/g/invites', {}],
    ['DELETE', '/api/groups/g/invites/i'],
    ['POST', '/api/invites/token/accept'],
    [
      'POST',
      '/api/groups/g/rounds',
      { name: '회차', participantIds: ['unit-user', 'other-user'] },
    ],
    ['DELETE', '/api/rounds/r', version],
    ['POST', '/api/rounds/r/settlement-check', { ...version, checked: true }],
    ...['confirm', 'reopen', 'send', 'draw', 'complete', 'force-complete'].map(
      (action) =>
        ['POST', `/api/rounds/r/${action}`, version] as [
          string,
          string,
          unknown,
        ],
    ),
    ['POST', '/api/rounds/r/expenses', expense],
    ['PATCH', '/api/rounds/r/expenses/e', version],
    ['DELETE', '/api/rounds/r/expenses/e', version],
    ['POST', '/api/rounds/r/members/u/exclude', version],
    ['POST', '/api/rounds/r/expenses/e/receipts'],
    ['DELETE', '/api/rounds/r/expenses/e/receipts/receipt', version],
    [
      'PUT',
      '/api/me/bank-account',
      {
        bankCode: '004',
        accountNumber: '001234',
        accountHolder: '사용자',
        expectedBankVersion: 1,
      },
    ],
  ];
  for (const [method, path, body] of cases)
    for (const value of [undefined, '', ' ']) {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: {
          origin,
          authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(value === undefined ? {} : { 'Idempotency-Key': value }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      assert.equal(
        response.status,
        400,
        `${method} ${path}: ${await response.clone().text()}`,
      );
      const payload = await response.json();
      assert.equal(payload.error, 'invalid_request_key');
      assert.equal(
        payload.message,
        path === '/api/groups'
          ? 'UUIDv7 모임 생성 키가 필요합니다'
          : path === '/api/groups/g/rounds'
            ? 'UUIDv7 회차 생성 ticket이 필요합니다'
            : '올바른 요청 키가 필요합니다',
      );
    }
  assert.equal(
    calls.length,
    0,
    'missing headers never reach services or their database calls',
  );
  const accepted = await fetch(`${origin}/api/groups`, {
    method: 'POST',
    headers: {
      origin,
      authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'header-value',
    },
    body: '{"name":"모임"}',
  });
  assert.equal(accepted.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0][1],
    'header-value',
    'the required-header decorator passes the original header to the service',
  );
  const unauthenticated = await fetch(`${origin}/api/groups`, {
    method: 'POST',
    headers: { origin, 'Content-Type': 'application/json' },
    body: '{"name":"모임"}',
  });
  assert.equal(
    unauthenticated.status,
    401,
    'JWT rejection still precedes required-header validation',
  );
  assert.equal(calls.length, 1);
});
