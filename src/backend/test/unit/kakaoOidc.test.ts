import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { ResponseCookies } from '@edge-runtime/cookies';
import {
  createMockBackend,
  mockFetch,
  mockOrigin,
} from '../support/mockHttpTestSupport';
import { AuthService } from '../../global/auth/service/auth.service';
import { KakaoOidcClient } from '../../global/auth/service/kakaoOidc.client';
import {
  OIDC_COOKIE_NAMES,
  REFRESH_TOKEN_COOKIE_NAME,
  RETURN_TO_COOKIE_NAME,
} from '../../global/auth/native';
import { requestMockServer } from '../support/mockHttpTestSupport';

const config = {
  clientId: 'isolated-oidc-client',
  clientSecret: 'isolated-client-secret',
  redirectUri: 'http://localhost:3000/auth/v1/kakao',
};
const issuer = 'https://kauth.kakao.com';
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const key = {
  ...publicKey.export({ format: 'jwk' }),
  kid: 'isolated-key',
  alg: 'RS256',
  use: 'sig',
};

function idToken(
  nonce: string,
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const content = [
    { alg: 'RS256', kid: key.kid, ...header },
    {
      iss: issuer,
      aud: config.clientId,
      sub: 'isolated-subject',
      iat: now,
      exp: now + 600,
      nonce,
      ...claims,
    },
  ]
    .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
    .join('.');
  return `${content}.${sign('RSA-SHA256', Buffer.from(content), privateKey).toString('base64url')}`;
}

test('Kakao OIDC SDK validates state before exchange and retries only missing JWKS keys', async (t) => {
  const client = new KakaoOidcClient();
  const authorization = await client.authorize(config);
  const url = new URL(authorization.url);
  assert.equal(url.origin, issuer);
  assert.equal(url.pathname, '/oauth/authorize');
  assert.equal(
    url.searchParams.get('scope'),
    'openid,profile_nickname,profile_image,account_email',
  );
  assert.equal(url.searchParams.get('redirect_uri'), config.redirectUri);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), authorization.state);
  assert.equal(url.searchParams.get('nonce'), authorization.nonce);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(
    url.searchParams.get('code_challenge'),
    createHash('sha256').update(authorization.codeVerifier).digest('base64url'),
  );
  assert.match(authorization.codeVerifier, /^[A-Za-z0-9_-]{43,128}$/);
  let exchanges = 0,
    jwks = 0;
  const provider = t.mock.method(
    globalThis,
    'fetch',
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      assert.equal(init?.redirect, 'error');
      assert.equal(init?.cache, 'no-store');
      assert.ok(init?.signal);
      if (String(input) === `${issuer}/oauth/token`) {
        exchanges++;
        const body = new URLSearchParams(String(init?.body));
        assert.equal(body.get('client_id'), config.clientId);
        assert.equal(body.get('client_secret'), config.clientSecret);
        assert.equal(body.get('code_verifier'), authorization.codeVerifier);
        assert.equal(body.get('redirect_uri'), config.redirectUri);
        assert.equal(body.get('grant_type'), 'authorization_code');
        return Response.json({
          access_token: 'isolated-access',
          token_type: 'bearer',
          id_token: idToken(authorization.nonce),
        });
      }
      assert.equal(String(input), `${issuer}/.well-known/jwks.json`);
      jwks++;
      return Response.json({
        keys: jwks === 1 ? [{ ...key, kid: 'previous-key' }] : [key],
      });
    },
  );
  assert.equal(
    await client.authenticate(config, 'code', 'wrong-state', authorization),
    null,
  );
  assert.equal(provider.mock.callCount(), 0);
  const expected = {
    accessToken: 'isolated-access',
    subject: 'isolated-subject',
  };
  assert.deepEqual(
    await client.authenticate(
      config,
      'code',
      authorization.state,
      authorization,
    ),
    expected,
  );
  assert.equal(
    exchanges,
    1,
    'JWKS rotation never exchanges the single-use code again',
  );
  assert.equal(jwks, 2, 'unknown kid triggers exactly one uncached reload');
  assert.deepEqual(
    await client.authenticate(
      config,
      'other-code',
      authorization.state,
      authorization,
    ),
    expected,
  );
  assert.equal(jwks, 2, 'the Provider owns a reusable JWKS cache');

  for (const metadata of [
    { ...key, use: 'enc' },
    { ...key, alg: undefined },
    { ...key, use: undefined },
    { ...key, n: 'YWJj', e: 'YWJj' },
  ]) {
    const separate = new KakaoOidcClient();
    let calls = 0;
    provider.mock.mockImplementation(
      async (input: Parameters<typeof fetch>[0]) => {
        if (String(input).endsWith('/oauth/token'))
          return Response.json({
            access_token: 'isolated-access',
            token_type: 'bearer',
            id_token: idToken(authorization.nonce),
          });
        calls++;
        return Response.json({ keys: [metadata] });
      },
    );
    assert.equal(
      await separate.authenticate(
        config,
        'code',
        authorization.state,
        authorization,
      ),
      null,
    );
    assert.equal(
      calls,
      1,
      'matching malformed metadata never causes a rotation retry',
    );
  }
  provider.mock.mockImplementation(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).endsWith('/oauth/token')) {
        const body = new URLSearchParams(String(init?.body));
        assert.equal(body.get('client_id'), config.clientId);
        assert.equal(
          body.has('client_secret'),
          false,
          'public Kakao clients remain supported',
        );
        return Response.json({
          access_token: 'isolated-access',
          token_type: 'bearer',
          id_token: idToken(authorization.nonce),
        });
      }
      return Response.json({ keys: [key] });
    },
  );
  assert.deepEqual(
    await new KakaoOidcClient().authenticate(
      { ...config, clientSecret: undefined },
      'code',
      authorization.state,
      authorization,
    ),
    expected,
  );
});

test('actual Kakao HTTP uses the injected OIDC client and rejects invalid tokens before account writes', async (t) => {
  const previous = Object.fromEntries(
    [
      'NODE_ENV',
      'AUTH_JWT_SECRET',
      'KAKAO_REST_API_KEY',
      'KAKAO_CLIENT_SECRET',
      'KAKAO_REDIRECT_URI',
    ].map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, {
    NODE_ENV: 'development',
    AUTH_JWT_SECRET: 'isolated-oidc-session-secret-at-least-32-bytes',
    KAKAO_REST_API_KEY: config.clientId,
    KAKAO_CLIENT_SECRET: config.clientSecret,
    KAKAO_REDIRECT_URI: config.redirectUri,
  });
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const { app } = await createMockBackend();
  t.after(() => app.close());

  const origin = mockOrigin(app);
  const oidc = app.get(KakaoOidcClient);
  const authenticate = t.mock.method(oidc, 'authenticate');
  const authorize = t.mock.method(oidc, 'authorize');
  const signIn = t.mock.method(
    app.get(AuthService),
    'signInKakao',
    async () => ({
      accessToken: 'isolated-app-access',
      accessMaxAge: 600,
      refreshToken: 'isolated-app-refresh',
      refreshMaxAge: 600,
      purpose: 'app' as const,
      userId: 'isolated-user',
    }),
  );
  let mode = 'valid';
  let claims: Record<string, unknown> = {},
    header: Record<string, unknown> = {};
  let nonce = '',
    verifier = '';
  let tokenRequests = 0,
    jwksRequests = 0,
    userInfoRequests = 0;
  const detailedProfile = {
    kakao_account: {
      email: 'verified@example.com',
      is_email_valid: true,
      is_email_verified: true,
      profile: {
        nickname: '다모아 닉네임',
        profile_image_url: 'https://cdn.example.com/full.png',
      },
    },
  };
  t.mock.method(
    globalThis,
    'fetch',
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input));
      assert.equal(init?.redirect, 'error');
      assert.ok(init?.signal);
      if (url.href === `${issuer}/oauth/token`) {
        tokenRequests++;
        const body = new URLSearchParams(String(init?.body));
        assert.equal(body.get('client_id'), config.clientId);
        assert.equal(body.get('client_secret'), config.clientSecret);
        assert.equal(body.get('redirect_uri'), config.redirectUri);
        assert.equal(body.get('code_verifier'), verifier);
        if (mode === 'provider-error')
          return Response.json({ error: 'invalid_grant' }, { status: 400 });
        if (mode === 'malformed-response')
          return Response.json({ access_token: 123 });
        if (mode === 'timeout') {
          await new Promise<void>((_, reject) => {
            init!.signal!.addEventListener(
              'abort',
              () => reject(init!.signal!.reason),
              { once: true },
            );
          });
        }
        let token = idToken(nonce, claims, header);
        if (mode === 'signature') token = `${token.slice(0, -4)}AAAA`;
        if (mode === 'malformed-token') token = 'malformed';
        return Response.json({
          access_token: 'isolated-access',
          id_token: token,
          token_type: 'bearer',
          expires_in: 600,
        });
      }
      if (url.href === `${issuer}/.well-known/jwks.json`) {
        jwksRequests++;
        if (mode === 'key-network')
          throw new TypeError('isolated unavailable JWKS');
        return Response.json({ keys: [key] });
      }
      if (url.pathname === '/v1/oidc/userinfo') {
        userInfoRequests++;
        return Response.json({
          sub:
            mode === 'wrong-profile-sub' ? 'another-user' : 'isolated-subject',
          nickname: 'OIDC 닉네임',
          email_verified: true,
          email: 'oidc@example.com',
          picture: 'http://cdn.example.com/unsafe.png',
        });
      }
      assert.equal(url.pathname, '/v2/user/me');
      assert.equal(url.searchParams.get('secure_resource'), 'true');
      return Response.json(detailedProfile);
    },
  );
  const login = async () => {
    const response = await requestMockServer(
      origin,
      new Request('http://localhost:3000/api/auth/kakao?returnTo=/home/groups'),
    );
    assert.equal(response.status, 307);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const url = new URL(response.headers.get('location')!);
    nonce = url.searchParams.get('nonce')!;
    const cookies = new ResponseCookies(response.headers).getAll();
    verifier = cookies.find(
      (cookie) => cookie.name === OIDC_COOKIE_NAMES.codeVerifier,
    )!.value;
    const state = url.searchParams.get('state')!;
    return new Request(
      `${config.redirectUri}?code=isolated-code&state=${state}`,
      {
        headers: {
          cookie: cookies
            .map(({ name, value }) => `${name}=${value}`)
            .join('; '),
        },
      },
    );
  };
  const finish = async (error?: 'failed' | 'invalid') => {
    const response = await requestMockServer(origin, await login(), 15_000);
    assert.equal(response.status, 307);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const destination = new URL(response.headers.get('location')!);
    assert.equal(destination.searchParams.get('returnTo'), '/home/groups');
    const cookies = new ResponseCookies(response.headers);
    for (const name of Object.values(OIDC_COOKIE_NAMES))
      assert.match(
        response.headers
          .getSetCookie()
          .find((value) => value.startsWith(`${name}=`))!,
        /Max-Age=0/,
      );
    if (error) {
      assert.equal(destination.pathname, '/login');
      assert.equal(destination.searchParams.get('error'), error);
      assert.equal(cookies.get(REFRESH_TOKEN_COOKIE_NAME), undefined);
    } else {
      assert.equal(destination.pathname, '/auth/complete');
      assert.equal(
        cookies.get(REFRESH_TOKEN_COOKIE_NAME)?.value,
        'isolated-app-refresh',
      );
      const clearReturn = response.headers
        .getSetCookie()
        .find((value) => value.startsWith(`${RETURN_TO_COOKIE_NAME}=`));
      assert.ok(clearReturn);
      assert.match(clearReturn, /Max-Age=0/);
    }
  };
  await finish();
  assert.deepEqual(signIn.mock.calls[0].arguments, [
    'isolated-subject',
    {
      displayName: '다모아 닉네임',
      email: 'verified@example.com',
      profileImageUrl: 'https://cdn.example.com/full.png',
    },
  ]);
  assert.equal(jwksRequests, 1);
  assert.equal(tokenRequests, 1);
  const failures: Array<
    [string, Record<string, unknown>, Record<string, unknown>]
  > = [
    ['nonce', { nonce: 'wrong' }, {}],
    ['issuer', { iss: 'https://attacker.example' }, {}],
    ['audience', { aud: 'other-client' }, {}],
    ['azp', { aud: [config.clientId, 'other-client'], azp: 'wrong' }, {}],
    ['missing-azp', { aud: [config.clientId, 'other-client'] }, {}],
    [
      'bad-audience-array',
      { aud: [config.clientId, 1], azp: config.clientId },
      {},
    ],
    ['expired', { exp: Math.floor(Date.now() / 1000) - 61 }, {}],
    ['fractional-exp', { exp: Math.floor(Date.now() / 1000) + 60.5 }, {}],
    ['fractional-iat', { iat: Math.floor(Date.now() / 1000) - 0.5 }, {}],
    ['future-iat', { iat: Math.floor(Date.now() / 1000) + 61 }, {}],
    ['missing-sub', { sub: '' }, {}],
    ['algorithm', {}, { alg: 'HS256' }],
    ['unsigned', {}, { alg: 'none' }],
    ['other-rsa-algorithm', {}, { alg: 'RS512' }],
    ['missing-kid', {}, { kid: undefined }],
    ['signature', {}, {}],
    ['malformed-token', {}, {}],
  ];
  for (const [label, payload, protectedHeader] of failures) {
    mode = label;
    claims = payload;
    header = protectedHeader;
    // Keep the +61s boundary fixed while the mock requests request is in flight.
    // A wall-clock second rollover otherwise turns this invalid token into +60s.
    if (label === 'future-iat') {
      const now = Date.now();
      t.mock.timers.enable({ apis: ['Date'], now });
      claims = { iat: Math.floor(now / 1000) + 61 };
    }
    try {
      await finish('invalid');
    } finally {
      if (label === 'future-iat') t.mock.timers.reset();
    }
    assert.equal(
      signIn.mock.callCount(),
      1,
      `${label} never reaches account persistence`,
    );
    assert.equal(
      userInfoRequests,
      1,
      `${label} never uses the access token for a profile request`,
    );
  }
  claims = {};
  header = {};
  for (const failure of [
    'provider-error',
    'malformed-response',
    'timeout',
    'key-network',
  ]) {
    mode = failure;
    header =
      failure === 'key-network' ? { kid: 'temporarily-unavailable-key' } : {};
    const started = Date.now();
    await finish('failed');
    if (failure === 'timeout')
      assert.ok(Date.now() - started >= 9_500 && Date.now() - started < 15_000);
    assert.equal(signIn.mock.callCount(), 1);
  }
  mode = 'valid';
  header = {};
  claims = {
    aud: [config.clientId, 'other-client'],
    azp: config.clientId,
    exp: Math.floor(Date.now() / 1000) - 30,
  };
  await finish();
  assert.equal(
    signIn.mock.callCount(),
    2,
    'valid authorized party and 60s clock grace remain compatible',
  );
  mode = 'wrong-profile-sub';
  claims = {};
  await finish();
  assert.deepEqual(
    signIn.mock.calls[2].arguments[1],
    { displayName: null, email: null, profileImageUrl: null },
    'verified ID token permits login when optional profile fails subject validation',
  );
  assert.equal(
    jwksRequests,
    2,
    'only the unavailable new kid adds JWKS traffic to each callback',
  );
  assert.ok(
    authenticate.mock.callCount() > 0 && authorize.mock.callCount() > 0,
    'actual routes use the registered OIDC Provider',
  );
});
