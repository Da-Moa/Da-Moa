import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { JwtService } from '@nestjs/jwt';
import type { Request, Response, NextFunction } from 'express';
import {
  createMockBackend,
  mockFetch,
  mockOrigin,
} from '../support/mockHttpTestSupport';
import { UserService } from '../../domain/user/service/user.service';
import { RealtimeUserRepository } from '../../domain/user/native';
import { TokenService } from '../../global/auth/service/token.service';
import { RealtimeAuthorizationService } from '../../global/auth/service/realtimeAuthorization.service';
import { RateLimitService } from '../../global/rateLimit/rateLimit.service';
import {
  createAccessToken,
  createRefreshToken,
} from '../support/legacyTokenTestSupport';
import { REFRESH_TOKEN_COOKIE_NAME } from '../../global/auth/native';

test('mock requests Guard, runtime limiter and WebSocket authorization use the same registered JWT verifier', async (t) => {
  const previous = process.env.AUTH_JWT_SECRET;
  process.env.AUTH_JWT_SECRET =
    'registered-verifier-test-secret-at-least-32-bytes';
  t.after(() => {
    if (previous === undefined) delete process.env.AUTH_JWT_SECRET;
    else process.env.AUTH_JWT_SECRET = previous;
  });
  const { app } = await createMockBackend(async (app) => {
    const limiter = app.get(RateLimitService);
    app.use((request: Request, response: Response, next: NextFunction) => {
      if (!limiter.handleRequest(request, response)) next();
    });
  });
  t.after(() => app.close());

  const origin = mockOrigin(app);
  const tokens = app.get(TokenService);
  const verifier = t.mock.method(app.get(JwtService), 'verify');
  const principal = {
    userId: 'verified-user',
    sessionId: 'sid',
    issuedAt: Math.floor(Date.now() / 1000),
    purpose: 'app' as const,
  };
  const account = t.mock.method(
    app.get(UserService),
    'getMe',
    async (user: Parameters<UserService['getMe']>[0]) => {
      assert.ok(user);
      assert.deepEqual(user, principal);
      return { id: user.userId };
    },
  );
  const state = t.mock.method(
    app.get(RealtimeUserRepository),
    'findState',
    async (userId: string) => {
      assert.equal(userId, principal.userId);
      return { id: userId, deleted_at: null, onboarding_completed_at: 1 };
    },
  );
  const limiter = app.get(RateLimitService);
  const realtime = app.get(RealtimeAuthorizationService);
  const getMe = async (token: string) => {
    const response = await mockFetch(app)(`${origin}/api/me`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    const body = await response.json();
    return { status: response.status, body };
  };
  for (const token of [
    createAccessToken(
      principal.userId,
      principal.sessionId,
      undefined,
      principal.issuedAt,
      600,
      'app',
    ),
    tokens.createAccessToken(
      principal.userId,
      principal.sessionId,
      principal.issuedAt,
      600,
      'app',
    ),
  ]) {
    const before = verifier.mock.callCount();
    const response = await getMe(token);
    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, principal.userId);
    assert.equal(
      verifier.mock.callCount() - before,
      2,
      'limiter and Guard each call the registered JwtService',
    );
    assert.deepEqual(await realtime.authenticate(token), {
      status: 200,
      id: principal.userId,
    });
    assert.equal(limiter.limitWebsocket(token, new PassThrough()), false);
    assert.equal(
      verifier.mock.callCount() - before,
      4,
      'WebSocket limiter and account authorization use that same library instance',
    );
  }
  assert.equal((await getMe('forged')).status, 401);
  assert.deepEqual(await realtime.authenticate('forged'), { status: 401 });
  const deniedSocket = new PassThrough();
  assert.equal(limiter.limitWebsocket('forged', deniedSocket), true);
  assert.equal(deniedSocket.destroyed, true);
  assert.equal(
    state.mock.callCount(),
    2,
    'bad signatures never query account state',
  );

  const before = verifier.mock.callCount();
  const refresh = createRefreshToken(
    principal.userId,
    principal.sessionId,
    undefined,
    principal.issuedAt,
    600,
    'app',
  );
  const response = await mockFetch(app)(`${origin}/api/auth/access-token`, {
    method: 'POST',
    headers: { origin, cookie: `${REFRESH_TOKEN_COOKIE_NAME}=${refresh}` },
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
  assert.equal(
    tokens.verifyAccessToken((await response.json()).data.accessToken)?.userId,
    principal.userId,
  );
  assert.equal(
    verifier.mock.callCount() - before,
    3,
    'refresh-cookie limiter/Guard and new access verification use JwtService',
  );

  // A container override reaches every consumer; no hidden previous-codec path.
  const verifiedBeforeOverride = verifier.mock.callCount();
  const override = t.mock.method(tokens, 'verifyAccessToken', () => principal);
  assert.equal((await getMe('provider-override-only')).status, 200);
  assert.deepEqual(await realtime.authenticate('provider-override-only'), {
    status: 200,
    id: principal.userId,
  });
  assert.equal(
    limiter.limitWebsocket('provider-override-only', new PassThrough()),
    false,
  );
  assert.equal(override.mock.callCount(), 4);
  assert.equal(verifier.mock.callCount(), verifiedBeforeOverride);
  assert.equal(account.mock.callCount(), 3);
});
