import assert from 'node:assert/strict';
import test from 'node:test';
import { channel } from 'node:diagnostics_channel';
import {
  BadRequestException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import {
  createMockBackend,
  mockFetch,
  mockOrigin,
} from '../support/mockHttpTestSupport';
import { UserService } from '../../domain/user/service/user.service';
import { TokenService } from '../../global/auth/service/token.service';
import { AppError } from '../../global/apiPayload/errors';
import {
  ACCESS_TOKEN_COOKIE_NAME,
  REFRESH_TOKEN_COOKIE_NAME,
} from '../../global/auth/native';

test('Nest 오류가 상태·본문·진단 정보·갱신 쿠키만 삭제하는 정책을 유지한다', async (t) => {
  const previous = {
    AUTH_JWT_SECRET: process.env.AUTH_JWT_SECRET,
    NODE_ENV: process.env.NODE_ENV,
  };
  Object.assign(process.env, {
    AUTH_JWT_SECRET: 'native-error-test-secret-at-least-32-bytes',
    NODE_ENV: 'development',
  });
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const { app } = await createMockBackend();
  t.after(() => app.close());

  const origin = mockOrigin(app);
  const tokens = app.get(TokenService);
  const token = tokens.createAccessToken('error-user', 'error-session');
  let failure: unknown;
  const called = t.mock.method(app.get(UserService), 'getMe', async () => {
    throw failure;
  });
  const logged = t.mock.method(console, 'error', () => {});
  let unexpected = 0;
  const exceptions = channel('da-moa.api.exception');
  const observe = () => {
    unexpected++;
  };
  exceptions.subscribe(observe);
  t.after(() => exceptions.unsubscribe(observe));
  const request = async (error: unknown, status: number, body: unknown) => {
    failure = error;
    const response = await mockFetch(app)(`${origin}/api/me`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.match(
      response.headers.get('content-type')!,
      /^application\/json(?:;|$)/,
    );
    assert.equal(response.headers.get('set-cookie'), null);
    assert.deepEqual(await response.json(), body);
  };
  for (const status of [400, 401, 403, 404, 409, 413, 503]) {
    await request(
      new AppError(status, 'contract_error', '기존 오류 메시지'),
      status,
      {
        error: 'contract_error',
        code: 'contract_error',
        detail: null,
        message: '기존 오류 메시지',
      },
    );
  }
  const details = { field: 'expectedVersion', version: 3 };
  await request(
    new AppError(409, 'stale_round', '다시 확인해 주세요', details),
    409,
    {
      error: 'stale_round',
      code: 'stale_round',
      detail: details,
      details,
      message: '다시 확인해 주세요',
    },
  );
  for (const code of ['22003', '22001'])
    await request({ code }, 400, {
      error: 'storage_value_limit',
      code: 'storage_value_limit',
      detail: null,
      message:
        '저장소가 처리할 수 있는 입력 크기를 넘었어요. 값을 확인해 주세요',
    });
  for (const [error, status, code] of [
    [new BadRequestException('잘못된 입력'), 400, 'invalid_input'],
    [new NotFoundException('없는 경로'), 404, 'not_found'],
    [new PayloadTooLargeException('파일 제한'), 413, 'invalid_input'],
  ] as const)
    await request(error, status, {
      error: code,
      code,
      detail: null,
      message: error.message,
    });
  assert.equal(unexpected, 0);
  assert.equal(logged.mock.callCount(), 0);
  const unknown = new Error('private connection details');
  await request(unknown, 503, {
    error: 'storage_unavailable',
    code: 'storage_unavailable',
    detail: null,
    message: '저장소에 연결하지 못했어요. 같은 요청으로 다시 시도해 주세요',
  });
  assert.equal(unexpected, 1);
  assert.deepEqual(logged.mock.calls[0].arguments, [
    'Unhandled server error',
    unknown,
  ]);

  const beforeGuard = called.mock.callCount();
  const denied = await mockFetch(app)(`${origin}/api/me`, {
    headers: { authorization: 'Bearer forged' },
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get('set-cookie'), null);
  assert.deepEqual(await denied.json(), {
    error: 'unauthorized',
    code: 'unauthorized',
    detail: null,
    message: '로그인이 필요합니다',
  });
  assert.equal(called.mock.callCount(), beforeGuard);
  for (const nodeEnv of ['development', 'production']) {
    Object.assign(process.env, { NODE_ENV: nodeEnv });
    for (const path of ['access-token', 'refresh']) {
      for (const cookie of [
        '',
        `${REFRESH_TOKEN_COOKIE_NAME}=forged`,
        `${REFRESH_TOKEN_COOKIE_NAME}=${token}`,
      ]) {
        const response = await mockFetch(app)(`${origin}/api/auth/${path}`, {
          method: 'POST',
          headers: { origin, cookie },
          signal: AbortSignal.timeout(10000),
        });
        assert.equal(response.status, 401);
        assert.equal(
          response.headers.get('cache-control'),
          'private, no-store',
        );
        assert.deepEqual(await response.json(), { error: 'unauthorized' });
        const cookies = response.headers.getSetCookie();
        assert.equal(cookies.length, 2);
        for (const [name, path] of [
          [ACCESS_TOKEN_COOKIE_NAME, '/'],
          [REFRESH_TOKEN_COOKIE_NAME, '/api/auth'],
        ]) {
          const clear = cookies.find((value) => value.startsWith(`${name}=`));
          assert.ok(clear);
          assert.match(clear, /Max-Age=0/);
          assert.ok(clear.split('; ').includes(`Path=${path}`));
          assert.match(clear, /HttpOnly/);
          assert.match(clear, /SameSite=Lax/i);
          assert.equal(clear.includes('Secure'), nodeEnv === 'production');
        }
      }
    }
  }
  assert.equal(
    unexpected,
    1,
    'expected authentication failures do not increment exception metrics',
  );
});
