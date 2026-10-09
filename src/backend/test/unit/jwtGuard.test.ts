import assert from 'node:assert/strict';
import test from 'node:test';
import { JwtGuard } from '../../global/auth/guard/jwt.guard';
import {
  jwtGuardForTest as jwtGuard,
  testTokens,
} from '../support/guardRequestTestSupport';
import {
  CurrentUser,
  type AuthenticatedRequest,
  type AuthenticatedUser,
} from '../../global/auth/decorator/currentUser.decorator';
import { AppError } from '../../global/apiPayload/errors';
import { type ExecutionContext } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants.js';
import {
  ACCESS_TOKEN_COOKIE_NAME,
  REFRESH_TOKEN_COOKIE_NAME,
  currentTimestamp,
} from '../../global/auth/native';
import {
  createAccessToken,
  createRefreshToken,
} from '../support/legacyTokenTestSupport.ts';

const proxy = (request: Request) =>
  jwtGuard(request) ??
  new Response(null, { headers: { 'x-middleware-next': '1' } });

test('global JwtGuard replaces untrusted user data and CurrentUser reads only verified claims', () => {
  const previous = process.env.AUTH_JWT_SECRET;
  process.env.AUTH_JWT_SECRET =
    'isolated-jwt-principal-test-secret-at-least-32-bytes';
  try {
    class PrincipalProbe {
      identity(@CurrentUser() user: AuthenticatedUser) {
        return user;
      }
    }
    const [{ factory }] = Object.values(
      Reflect.getMetadata(ROUTE_ARGS_METADATA, PrincipalProbe, 'identity'),
    ) as {
      factory: (data: unknown, context: ExecutionContext) => AuthenticatedUser;
    }[];
    const token = createAccessToken('verified-user', 'verified-session');
    const request = (authorization: string, path = '/api/groups') =>
      ({
        method: 'GET',
        protocol: 'http',
        originalUrl: path,
        headers: { host: 'localhost', authorization },
        user: {
          userId: 'forged-user',
          sessionId: 'forged-session',
          issuedAt: 0,
        },
      }) as AuthenticatedRequest;
    const context = (request: AuthenticatedRequest) =>
      ({
        switchToHttp: () => ({ getRequest: () => request }),
      }) as unknown as ExecutionContext;
    const verified = request(`Bearer ${token}`),
      guard = new JwtGuard(testTokens);
    assert.equal(guard.canActivate(context(verified)), true);
    assert.equal(verified.user?.userId, 'verified-user');
    assert.equal(verified.user?.sessionId, 'verified-session');

    // Reading the principal after the guard does not parse or verify the JWT again.
    process.env.AUTH_JWT_SECRET =
      'different-secret-after-the-guard-at-least-32-bytes';
    assert.equal(factory(undefined, context(verified)), verified.user);
    const denied = request(`Bearer ${token}`);
    assert.throws(
      () => guard.canActivate(context(denied)),
      (error: unknown) => error instanceof AppError && error.status === 401,
    );
    assert.equal(denied.user, undefined);
    assert.throws(
      () => factory(undefined, context(denied)),
      (error: unknown) => error instanceof AppError && error.status === 401,
    );
    const health = request('', '/api/health/live');
    assert.equal(guard.canActivate(context(health)), true);
    assert.equal(
      health.user,
      undefined,
      'public requests do not inherit supplied identity',
    );
  } finally {
    if (previous === undefined) delete process.env.AUTH_JWT_SECRET;
    else process.env.AUTH_JWT_SECRET = previous;
  }
});

test('Node JWT guard rejects protected requests before body validation and permits only explicit public routes', async () => {
  const previous = process.env.AUTH_JWT_SECRET;
  process.env.AUTH_JWT_SECRET =
    'isolated-jwt-guard-test-secret-at-least-32-bytes';
  try {
    const now = currentTimestamp();
    const access = createAccessToken('user', 'session');
    const refresh = createRefreshToken('user', 'session');
    const request = (path: string, method = 'GET', cookie = '') =>
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          cookie,
          ...(cookie.startsWith(`${ACCESS_TOKEN_COOKIE_NAME}=`)
            ? {
                authorization: `Bearer ${cookie.slice(ACCESS_TOKEN_COOKIE_NAME.length + 1)}`,
              }
            : {}),
          'x-middleware-subrequest': 'proxy:proxy:proxy:proxy:proxy',
        },
        ...(method === 'POST' ? { body: '{invalid json' } : {}),
      });
    for (const path of [
      '/api/groups',
      '/api/me',
      '/api/me/onboarding',
      '/api/me/bank-account',
      '/api/rounds/id',
      '/api/invites/token',
      '/api/docs',
      '/api/openapi.json',
      '/api/unknown',
    ]) {
      for (const method of [
        'GET',
        'POST',
        'PUT',
        'PATCH',
        'DELETE',
        'HEAD',
        'OPTIONS',
      ]) {
        const denied = proxy(request(path, method));
        assert.equal(denied.status, 401, `${method} ${path}`);
        assert.equal(denied.headers.get('Cache-Control'), 'private, no-store');
      }
    }
    for (const token of [
      'invalid',
      `${access.slice(0, -1)}!`,
      createAccessToken('user', 'session', undefined, now - 10, 1),
      refresh,
    ]) {
      assert.equal(
        proxy(
          request(
            '/api/groups',
            'POST',
            `${ACCESS_TOKEN_COOKIE_NAME}=${token}`,
          ),
        ).status,
        401,
      );
    }
    assert.equal(
      proxy(
        request('/api/groups', 'POST', `${ACCESS_TOKEN_COOKIE_NAME}=${access}`),
      ).headers.get('x-middleware-next'),
      '1',
    );
    assert.equal(
      proxy(
        new Request('http://localhost/api/groups', {
          headers: { cookie: `${ACCESS_TOKEN_COOKIE_NAME}=${access}` },
        }),
      ).status,
      401,
    );
    for (const path of [
      '/api/health',
      '/api/health/live',
      '/api/health/database',
      '/api/health/minio',
      '/api/health/dependencies',
      '/api/health/worker',
      '/api/health/worker/readyz',
    ]) {
      for (const method of ['GET', 'HEAD'])
        assert.equal(
          proxy(request(path, method)).headers.get('x-middleware-next'),
          '1',
        );
      assert.equal(proxy(request(path, 'POST')).status, 401);
    }
    for (const path of [
      '/api/health-extra',
      '/api/health/live/extra',
      '/api/health/worker/extra',
      '/api/health/worker/readyz/extra',
      '/api/auth/kakao/extra',
      '/api/auth/test-login/extra',
      '/api/auth/unknown',
    ]) {
      assert.equal(proxy(request(path)).status, 401);
    }
    assert.equal(
      proxy(request('/api/auth/kakao')).headers.get('x-middleware-next'),
      '1',
    );
    assert.equal(proxy(request('/api/auth/kakao', 'POST')).status, 401);
    assert.equal(
      proxy(request('/api/auth/test-login', 'POST')).headers.get(
        'x-middleware-next',
      ),
      '1',
    );
    const refreshCookie = `${REFRESH_TOKEN_COOKIE_NAME}=${refresh}`;
    for (const path of ['/api/auth/refresh', '/api/auth/access-token']) {
      assert.equal(
        proxy(request(path, 'POST', refreshCookie)).headers.get(
          'x-middleware-next',
        ),
        '1',
      );
      assert.equal(
        proxy(request(path, 'POST', `${ACCESS_TOKEN_COOKIE_NAME}=${access}`))
          .status,
        401,
      );
    }
    assert.equal(
      proxy(
        request(
          '/api/auth/refresh',
          'POST',
          `${REFRESH_TOKEN_COOKIE_NAME}=${access}`,
        ),
      ).status,
      401,
    );
    const refreshDenied = proxy(
      request(
        '/api/auth/refresh',
        'POST',
        `${ACCESS_TOKEN_COOKIE_NAME}=${access}`,
      ),
    );
    assert.equal(refreshDenied.status, 401);
    assert.match(refreshDenied.headers.get('set-cookie')!, /Max-Age=0/);
    assert.equal(
      proxy(request('/api/auth/logout', 'POST', refreshCookie)).headers.get(
        'x-middleware-next',
      ),
      '1',
    );
    assert.equal(
      proxy(
        request(
          '/api/auth/logout',
          'POST',
          `${ACCESS_TOKEN_COOKIE_NAME}=${access}`,
        ),
      ).headers.get('x-middleware-next'),
      '1',
    );
    assert.equal(proxy(request('/api/auth/logout', 'POST')).status, 401);
    assert.equal(jwtGuard(request('/auth/v1/kakao')), null);
  } finally {
    if (previous === undefined) delete process.env.AUTH_JWT_SECRET;
    else process.env.AUTH_JWT_SECRET = previous;
  }
});
