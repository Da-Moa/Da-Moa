import { TokenService } from '../../global/auth/service/token.service';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response, NextFunction } from 'express';
import { createBackend } from '../../domain/main';
import { REFRESH_TOKEN_COOKIE_NAME } from '../../global/auth/native';
import { createRefreshToken } from '../support/legacyTokenTestSupport.ts';
import {
  createRateLimitController,
  createTokenBuckets,
} from '../../global/rateLimit/native';

test('actual Nest HTTP limiter and JWT Guard use the same parsed refresh-cookie identity and reject duplicates consistently', async (t) => {
  const previous = process.env.AUTH_JWT_SECRET;
  process.env.AUTH_JWT_SECRET = 'cookie-limiter-test-secret-at-least-32-bytes';
  let limiter: ReturnType<typeof createRateLimitController>;
  const { app } = await createBackend(async (app) => {
    limiter = createRateLimitController(
      app.get(TokenService),
      createTokenBuckets(() => 0),
    );
    app.use((request: Request, response: Response, next: NextFunction) => {
      if (!limiter.handleRequest(request, response)) next();
    });
  });
  t.after(async () => {
    limiter.close();
    await app.close();
    if (previous === undefined) delete process.env.AUTH_JWT_SECRET;
    else process.env.AUTH_JWT_SECRET = previous;
  });
  await app.listen(0, '127.0.0.1');
  const origin = await app.getUrl();
  const token = createRefreshToken('cookie-limit-user', 'first-session');
  const other = createRefreshToken('different-cookie-user', 'second-session');
  const cookie = `${REFRESH_TOKEN_COOKIE_NAME}=${token.replace(/\./g, '%2E')}`;
  const request = (cookie: string) =>
    fetch(`${origin}/api/auth/access-token`, {
      method: 'POST',
      headers: { origin, cookie },
      signal: AbortSignal.timeout(10000),
    });
  for (let i = 0; i < 5; i++) {
    const response = await request(cookie);
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  for (const trailing of ['invalid', other]) {
    const response = await request(
      `${cookie}; ${REFRESH_TOKEN_COOKIE_NAME}=${trailing}`,
    );
    assert.equal(
      response.status,
      429,
      'a second cookie cannot bypass the first authenticated user quota',
    );
    assert.equal(response.headers.get('set-cookie'), null);
    assert.ok(Number(response.headers.get('retry-after')) > 0);
    await response.arrayBuffer();
  }
  for (const first of [
    'invalid',
    encodeURIComponent('j:{"token":"forged"}'),
    encodeURIComponent('j:["forged"]'),
  ]) {
    const response = await request(
      `${REFRESH_TOKEN_COOKIE_NAME}=${first}; ${cookie}`,
    );
    assert.equal(
      response.status,
      401,
      'an invalid first cookie reaches the Guard instead of consuming a later identity quota',
    );
    assert.deepEqual(await response.json(), { error: 'unauthorized' });
  }
  const independent = await request(`${REFRESH_TOKEN_COOKIE_NAME}=${other}`);
  assert.equal(independent.status, 200);
  await independent.arrayBuffer();
});
