import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  createAccessToken,
  createRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  ACCESS_TOKEN_MAX_AGE_SECONDS,
  REFRESH_TOKEN_MAX_AGE_SECONDS,
} from '../../global/auth/native';
import { TokenModule } from '../../global/auth/module/token.module';
import { TokenService } from '../../global/auth/service/token.service';

const secret = 'token-library-test-secret-at-least-32-bytes';
const timestamp = 1000;
const payload = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

test('Nest JWT and previous codec accept each other with identical access/refresh claims and expiry boundaries', (t) => {
  const jwt = new JwtService({ secret });
  const tokens = new TokenService(jwt);
  const sign = t.mock.method(jwt, 'sign');
  const verify = t.mock.method(jwt, 'verify');
  for (const purpose of [undefined, 'app', 'onboarding'] as const) {
    for (const type of ['access', 'refresh'] as const) {
      const createPrevious =
        type === 'access' ? createAccessToken : createRefreshToken;
      const verifyPrevious =
        type === 'access' ? verifyAccessToken : verifyRefreshToken;
      const createCurrent = (
        type === 'access' ? tokens.createAccessToken : tokens.createRefreshToken
      ).bind(tokens);
      const verifyCurrent = (
        type === 'access' ? tokens.verifyAccessToken : tokens.verifyRefreshToken
      ).bind(tokens);
      const maxAge =
        purpose === 'onboarding'
          ? 600
          : type === 'access'
            ? ACCESS_TOKEN_MAX_AGE_SECONDS
            : REFRESH_TOKEN_MAX_AGE_SECONDS;
      const previous = createPrevious(
        'user-id',
        'session-id',
        secret,
        timestamp,
        maxAge,
        purpose,
      );
      const current = createCurrent(
        'user-id',
        'session-id',
        timestamp,
        maxAge,
        purpose,
      );
      assert.deepEqual(payload(current), payload(previous));
      for (const token of [previous, current]) {
        assert.deepEqual(
          verifyCurrent(token, timestamp + 1),
          verifyPrevious(token, secret, timestamp + 1),
        );
        assert.ok(verifyCurrent(token, timestamp + maxAge - 1));
        assert.equal(verifyCurrent(token, timestamp + maxAge), null);
        assert.equal(
          type === 'access'
            ? tokens.verifyRefreshToken(token, timestamp)
            : tokens.verifyAccessToken(token, timestamp),
          null,
        );
      }
    }
  }
  assert.equal(
    sign.mock.callCount(),
    6,
    'injected JwtService signs all six token combinations',
  );
  assert.ok(
    verify.mock.callCount() >= 48,
    'injected JwtService performs signature and standard-claim verification',
  );
});

test('Nest JWT keeps the previous malformed-token, signing-algorithm, application-claim and clock policy', () => {
  const tokens = new TokenService(new JwtService({ secret }));
  const claims = payload(
    createAccessToken('user-id', 'session-id', secret, timestamp),
  );
  const signed = (
    body: unknown,
    header: unknown = { alg: 'HS256', typ: 'JWT' },
    key = secret,
  ) => {
    const input = [header, body]
      .map((value) => Buffer.from(JSON.stringify(value)).toString('base64url'))
      .join('.');
    return `${input}.${createHmac('sha256', key).update(input).digest('base64url')}`;
  };
  const invalid = [
    undefined,
    '',
    'invalid',
    'a.b.c',
    signed('text'),
    signed([]),
    signed(claims, { alg: 'none', typ: 'JWT' }),
    signed(claims, { alg: 'HS384', typ: 'JWT' }),
    signed(claims, { alg: 'HS256', typ: 'other' }),
    signed(claims, { alg: 'HS256' }),
    signed(claims, undefined, `${secret}-wrong`),
    ...[
      { aud: 'other' },
      { aud: ['da-moa'] },
      { iss: 'other' },
      { token_type: 'refresh' },
      { purpose: 'other' },
      { purpose: null },
      { sub: '' },
      { sub: 1 },
      { sid: '' },
      { sid: null },
      { exp: timestamp },
      { exp: timestamp + 10.5 },
      { exp: '1600' },
      { iat: timestamp + 61 },
      { iat: timestamp + 0.5 },
      { iat: '1000' },
    ].map((change) => signed({ ...claims, ...change })),
    ...['aud', 'iss', 'token_type', 'sub', 'sid', 'exp', 'iat'].map((name) => {
      const missing = { ...claims };
      delete missing[name];
      return signed(missing);
    }),
  ];
  const valid = signed(claims);
  invalid.push(
    `${valid}x`,
    `${valid.slice(0, -1)}${valid.endsWith('a') ? 'b' : 'a'}`,
  );
  for (const token of invalid) {
    assert.equal(verifyAccessToken(token, secret, timestamp), null);
    assert.equal(tokens.verifyAccessToken(token, timestamp), null);
  }
  for (const change of [
    { iat: timestamp + 60 },
    { nbf: timestamp + 100 },
    { nbf: 'unused' },
  ]) {
    const token = signed({ ...claims, ...change });
    assert.deepEqual(
      tokens.verifyAccessToken(token, timestamp),
      verifyAccessToken(token, secret, timestamp),
    );
    assert.ok(tokens.verifyAccessToken(token, timestamp));
  }
});

test('stateless renewal shares sid, preserves purpose and never extends onboarding expiry', (t) => {
  t.mock.method(Date, 'now', () => timestamp * 1000);
  const tokens = new TokenService(new JwtService({ secret }));
  for (const purpose of ['app', 'onboarding'] as const) {
    const session = tokens.issueTokens('user-id', purpose);
    const access = payload(session.accessToken);
    const refreshClaims = payload(session.refreshToken);
    assert.equal(access.sid, refreshClaims.sid);
    assert.match(access.sid, /^[a-f0-9-]{36}$/);
    assert.equal(access.exp, timestamp + 600);
    assert.equal(
      refreshClaims.exp,
      timestamp + (purpose === 'app' ? REFRESH_TOKEN_MAX_AGE_SECONDS : 600),
    );
    t.mock.method(Date, 'now', () => (timestamp + 590) * 1000);
    const refresh = tokens.verifyRefreshToken(session.refreshToken)!;
    assert.ok(refresh);
    for (let i = 0; i < 2; i++) {
      const current = tokens.accessTokenForRefresh(refresh);
      const renewed = tokens.refreshTokens(refresh);
      for (const token of [
        current.accessToken,
        renewed.accessToken,
        renewed.refreshToken,
      ]) {
        const claims = payload(token);
        assert.equal(claims.sid, refresh.sessionId);
        assert.equal(claims.sub, 'user-id');
        assert.equal(claims.purpose, purpose);
      }
      if (purpose === 'onboarding') {
        assert.equal(payload(current.accessToken).exp, refresh.expiresAt);
        assert.equal(payload(renewed.accessToken).exp, refresh.expiresAt);
        assert.equal(payload(renewed.refreshToken).exp, refresh.expiresAt);
        assert.equal(renewed.refreshMaxAge, 10);
      } else {
        assert.equal(payload(current.accessToken).exp, timestamp + 1190);
        assert.equal(renewed.refreshMaxAge, REFRESH_TOKEN_MAX_AGE_SECONDS);
      }
    }
    t.mock.method(Date, 'now', () => timestamp * 1000);
  }
});

test('TokenModule initializes without a secret and its injected JWT provider resolves validated configuration per operation', async (t) => {
  const previous = process.env.AUTH_JWT_SECRET;
  t.after(() => {
    if (previous === undefined) delete process.env.AUTH_JWT_SECRET;
    else process.env.AUTH_JWT_SECRET = previous;
  });
  delete process.env.AUTH_JWT_SECRET;
  const app = await NestFactory.createApplicationContext(TokenModule, {
    logger: false,
  });
  t.after(() => app.close());
  const tokens = app.get(TokenService);
  const sign = t.mock.method(app.get(JwtService), 'sign');
  const verify = t.mock.method(app.get(JwtService), 'verify');
  for (const key of [undefined, 'too-short']) {
    if (key === undefined) delete process.env.AUTH_JWT_SECRET;
    else process.env.AUTH_JWT_SECRET = key;
    assert.throws(
      () => tokens.createAccessToken('user', 'sid'),
      /at least 32 bytes/,
    );
    assert.equal(
      tokens.verifyAccessToken(
        createAccessToken('user', 'sid', secret, timestamp),
        timestamp,
      ),
      null,
    );
  }
  process.env.AUTH_JWT_SECRET = secret;
  const token = tokens.createAccessToken('user', 'sid', timestamp);
  assert.ok(tokens.verifyAccessToken(token, timestamp));
  process.env.AUTH_JWT_SECRET = `${secret}-rotated`;
  assert.equal(tokens.verifyAccessToken(token, timestamp), null);
  assert.ok(
    tokens.verifyAccessToken(
      tokens.createAccessToken('user', 'sid', timestamp),
      timestamp,
    ),
  );
  assert.equal(sign.mock.callCount(), 4);
  assert.equal(verify.mock.callCount(), 5);
});
