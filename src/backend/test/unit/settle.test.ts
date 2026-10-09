import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatch as GET } from '../support/httpTestSupport';
import { createAccessToken } from '../../global/auth/authUtil';

test('Settle dispatch preserves routes, origin, JSON and multipart validation before DB work', async (t) => {
  const previous = process.env.AUTH_JWT_SECRET;
  process.env.AUTH_JWT_SECRET =
    'isolated-settle-unit-test-secret-at-least-32-bytes';
  t.after(() => {
    if (previous === undefined) delete process.env.AUTH_JWT_SECRET;
    else process.env.AUTH_JWT_SECRET = previous;
  });
  const token = createAccessToken('unit-user', 'unit-session');
  const request = (
    path: string,
    method: string,
    body?: string,
    origin = 'http://localhost',
    authenticated = true,
  ) =>
    GET(
      new Request(`http://localhost/api/${path}`, {
        method,
        headers: {
          origin,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'unit-request-key',
          ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body }),
      }),
      { params: Promise.resolve({ path: path.split('/') }) },
    );
  assert.equal(
    (
      await request(
        'rounds/id/confirm',
        'POST',
        '{invalid',
        'https://other.example',
      )
    ).status,
    403,
  );
  for (const [path, method] of [
    ['groups/id/rounds', 'POST'],
    ['rounds/id', 'DELETE'],
    ['rounds/id/expenses', 'POST'],
    ['rounds/id/expenses/e', 'PATCH'],
    ['rounds/id/expenses/e', 'DELETE'],
    ['rounds/id/members/u/exclude', 'POST'],
    ['rounds/id/settlement-check', 'POST'],
    ['rounds/id/expenses/e/receipts/r', 'DELETE'],
    ...['confirm', 'reopen', 'send', 'draw', 'complete', 'force-complete'].map(
      (action) => [`rounds/id/${action}`, 'POST'],
    ),
  ])
    assert.equal(
      (await request(path, method, '{invalid')).status,
      400,
      `${method} ${path}`,
    );
  assert.equal(
    (
      await request(
        'rounds/id/expenses/e/receipts',
        'POST',
        '{invalid',
        'http://localhost',
        false,
      )
    ).status,
    401,
  );
  for (const [path, method] of [
    ['rounds/id', 'PUT'],
    ['rounds/id/unknown', 'POST'],
    ['receipts/id', 'DELETE'],
  ]) {
    const response = await request(path, method);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  }
});
