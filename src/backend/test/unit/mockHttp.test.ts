import assert from 'node:assert/strict';
import test from 'node:test';
import { Server } from 'node:net';
import { createMockBackend } from '../support/mockHttpTestSupport';
import { GroupService } from '../../domain/group/service/group.service';
import { SettleService } from '../../domain/settle/service/settle.service';
import { TokenService } from '../../global/auth/service/token.service';
import { RealtimePublisher } from '../../global/util/invalidationUtil';
import { AppError } from '../../global/apiPayload/errors';

process.env.AUTH_JWT_SECRET = 'mock-http-unit-test-only-at-least-32-bytes';

test('서버 포트 없이 등록된 Nest 경로·Guard·Pipe·예외 필터·응답 완료를 검증한다', async (t) => {
  t.mock.method(Server.prototype, 'listen', () => {
    throw new Error('Mock tests must not listen');
  });
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Mock tests must not send HTTP');
  });
  const events: string[] = [];
  let calls = 0,
    failure = false;
  const groupService = {
    createGroup: async (
      user: any,
      key: string,
      body: any,
      capture: (ids: string[]) => void,
    ) => {
      calls++;
      events.push('service');
      assert.equal(user.userId, 'owner');
      assert.equal(key, 'mock-key');
      assert.equal(body.constructor.name, 'CreateGroupRequestDTO');
      if (failure) throw new AppError(409, 'mock_conflict', '검증용 충돌');
      capture(['owner']);
      return { id: 'group-one', name: body.name };
    },
    listGroups: async () => {
      calls++;
      return { items: [], nextCursor: null };
    },
  };
  const { app, origin, request } = await createMockBackend(
    async (app) => {
      app.use((_req: any, res: any, next: () => void) => {
        res.once('finish', () => events.push('finish'));
        next();
      });
      app.get(RealtimePublisher).registerInvalidationPublisher((user, keys) => {
        events.push('notify');
        assert.equal(user, 'owner');
        assert.deepEqual(keys, ['groups', 'group:group-one']);
      });
    },
    (builder) => builder.overrideProvider(GroupService).useValue(groupService),
  );
  t.after(() => app.close());
  const token = app
    .get(TokenService)
    .createAccessToken('owner', 'unit-session');
  const headers = {
    origin,
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'idempotency-key': 'mock-key',
  };
  const create = (body: BodyInit, extra: Record<string, string> = {}) =>
    request('/api/groups', {
      method: 'POST',
      headers: { ...headers, ...extra },
      body,
    });

  assert.equal((await create('{bad', { authorization: '' })).status, 401);
  assert.equal(
    (await create('{bad', { origin: 'https://foreign.test' })).status,
    403,
  );
  assert.equal((await create('{bad')).status, 400);
  assert.equal((await create('{"name":" "}')).status, 400);
  assert.equal(
    (await create('{"name":"정상"}', { 'idempotency-key': '' })).status,
    400,
  );
  assert.equal((await request('/api/groups?q=a&q=b', { headers })).status, 400);
  assert.equal(calls, 0);

  events.length = 0;
  const response = await create('{"name":"  여행 모임  "}');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal((await response.json()).data.name, '여행 모임');
  assert.deepEqual(events, ['service', 'finish', 'notify']);
  assert.deepEqual(response.notifications, [
    { userId: 'owner', keys: ['groups', 'group:group-one'] },
  ]);
  assert.equal(calls, 1);

  events.length = 0;
  failure = true;
  const conflict = await create('{"name":"여행 모임"}');
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, 'mock_conflict');
  assert.deepEqual(events, ['service', 'finish']);
  assert.equal(
    (await request('/api/groups', { method: 'OPTIONS', headers })).status,
    404,
  );
});

test('모의 본문 스트림으로 실제 multipart 권한 검사·파싱·바이너리 응답을 검증한다', async (t) => {
  let admissions = 0,
    saves = 0;
  const bytes = Buffer.from([0, 255, 2, 3]);
  const service = {
    admitReceipt: async (
      user: any,
      _key: string,
      roundId: string,
      expenseId: string,
    ) => {
      admissions++;
      if (user.userId !== 'owner')
        throw new AppError(403, 'forbidden', '접근 거절');
      return { roundId, expenseId };
    },
    saveReceipt: async (admission: any, file: any) => {
      saves++;
      assert.equal(admission.roundId, 'round');
      assert.equal(file.expectedVersion, 2);
      assert.equal(file.name, 'receipt.avif');
      assert.deepEqual(file.bytes, bytes);
      return { id: 'receipt', version: 3 };
    },
    getReceipt: async () => ({ mimeType: 'image/avif', content: bytes }),
  };
  const { app, origin, request } = await createMockBackend(
    undefined,
    (builder) => builder.overrideProvider(SettleService).useValue(service),
  );
  t.after(() => app.close());
  const tokens = app.get(TokenService);
  const headers = (user: string) => ({
    origin,
    authorization: `Bearer ${tokens.createAccessToken(user, 'unit')}`,
    'idempotency-key': 'mock-key',
  });
  const form = () => {
    const data = new FormData();
    data.set('expectedVersion', '2');
    data.set('file', new Blob([bytes], { type: 'image/avif' }), 'receipt.avif');
    return data;
  };
  let reads = 0;
  const denied = await request('/api/rounds/round/expenses/expense/receipts', {
    method: 'POST',
    headers: {
      ...headers('outsider'),
      'content-type': 'multipart/form-data; boundary=never-read',
    },
    chunks: {
      async *[Symbol.asyncIterator]() {
        reads++;
        yield bytes;
      },
    },
  });
  assert.equal(denied.status, 403);
  assert.equal(reads, 0);
  assert.equal(saves, 0);
  const accepted = await request(
    '/api/rounds/round/expenses/expense/receipts',
    { method: 'POST', headers: headers('owner'), body: form() },
  );
  assert.equal(accepted.status, 202);
  assert.equal(saves, 1);
  assert.equal((await accepted.json()).data.id, 'receipt');
  const invalid = form();
  invalid.append('file', new Blob([bytes]), 'second.avif');
  assert.equal(
    (
      await request('/api/rounds/round/expenses/expense/receipts', {
        method: 'POST',
        headers: headers('owner'),
        body: invalid,
      })
    ).status,
    400,
  );
  assert.equal(saves, 1);
  assert.equal(admissions, 3);
  const image = await request('/api/receipts/receipt', {
    headers: headers('owner'),
  });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/avif');
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
  assert.equal(
    (
      await request('/api/receipts/receipt', {
        method: 'HEAD',
        headers: headers('owner'),
      })
    ).status,
    200,
  );
});

test('모의 요청 시간 초과·취소 시 스트림을 정리하고 다음 요청을 허용한다', async (t) => {
  const { app, request } = await createMockBackend(async (app) => {
    app.use(
      '/mock-pending',
      (_req: unknown, _res: unknown, _next: unknown) => {},
    );
  });
  t.after(() => app.close());
  await assert.rejects(
    request('/mock-pending', { timeoutMilliseconds: 5 }),
    /Mock request timed out/,
  );
  const controller = new AbortController();
  const pending = request('/mock-pending', { signal: controller.signal });
  controller.abort(new Error('mock abort'));
  await assert.rejects(pending, /mock abort/);
  assert.equal((await request('/api/health/live')).status, 200);
});
