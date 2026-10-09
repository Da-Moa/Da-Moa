import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createBackend } from '../../domain/main';
import { UserService } from '../../domain/user/service/user.service';
import {
  BankAccountRequestDTO,
  OnboardingRequestDTO,
} from '../../domain/user/dto/req/user.request.dto';
import { createDatabaseClient } from '../../global/database/db';
import { createAccessToken, readAccessToken } from '../../global/auth/native';
import { signInKakao } from '../support/domainTestSupport';
import { applyMigrations } from '../../../../scripts/migrations.mjs';

const url = process.env.TEST_DATABASE_URL;
if (
  !url ||
  !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname) ||
  !new URL(url).pathname.includes('test')
)
  throw new Error('An isolated local test database is required');
process.env.DATABASE_URL = url;

test('account HTTP validates DTO shape before SQL and preserves normalized business fields and conditional persistence', async (t) => {
  const db = createDatabaseClient(url);
  await db.connect();
  t.after(() => db.end());
  await applyMigrations(db);
  const session = await signInKakao(`user-body:${randomUUID()}`, {
    displayName: '계좌 DTO 검증',
    email: null,
    profileImageUrl: null,
  });
  const { app } = await createBackend();
  t.after(() => app.close());
  await app.listen(0, '127.0.0.1');
  const origin = await app.getUrl();
  const service = app.get(UserService);
  for (const [method, dto] of [
    ['completeOnboarding', OnboardingRequestDTO],
    ['updateBankAccount', BankAccountRequestDTO],
  ] as const) {
    const original = service[method].bind(service);
    t.mock.method(service, method, (...args: unknown[]) => {
      const body = args[method === 'completeOnboarding' ? 1 : 2];
      assert.ok(body instanceof dto);
      return Reflect.apply(original, service, args);
    });
  }
  const previous = process.env.DB_QUERY_LOG;
  process.env.DB_QUERY_LOG = 'true';
  t.after(() => {
    if (previous === undefined) delete process.env.DB_QUERY_LOG;
    else process.env.DB_QUERY_LOG = previous;
  });
  let statements: string[] = [];
  t.mock.method(console, 'info', (message: string) => {
    statements.push(
      message
        .replace(/^SQL:\s*/, '')
        .replace(/\s+/g, ' ')
        .trim(),
    );
  });
  const request = async (
    path: string,
    input: unknown,
    status: number,
    count: number,
    token = session.accessToken,
  ) => {
    statements = [];
    const response = await fetch(`${origin}/api/me/${path}`, {
      method: path === 'onboarding' ? 'POST' : 'PUT',
      headers: {
        origin,
        authorization: token ? `Bearer ${token}` : '',
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(10000),
    });
    const body = await response.json();
    assert.equal(response.status, status, JSON.stringify(body));
    assert.equal(statements.length, count, statements.join('\n'));
    if (count) assert.match(statements[0], /"users" WHERE .*"id" = \$1/);
    if (count === 2) {
      if (path === 'onboarding')
        assert.match(
          statements[1],
          /^UPDATE "public"\."users" SET .*WHERE .*"id" = \$\d+.*"updated_at" = \$\d+.*"bank_version" = \$\d+/,
        );
      else
        assert.match(
          statements[1],
          /^UPDATE users SET .* WHERE id = \$1 AND bank_version = \$8/,
        );
    }
    assert.ok(
      statements.every(
        (sql) =>
          !/^(BEGIN|COMMIT|ROLLBACK|SET)\b|pg_advisory|FOR UPDATE|FOR SHARE/.test(
            sql,
          ),
      ),
    );
    return body;
  };
  const input = {
    bankCode: '002',
    accountNumber: '031-1234 5678-901',
    accountHolder: ' \u1100\u1161계좌 ',
    expectedBankVersion: 0,
  };
  for (const path of ['onboarding', 'bank-account']) {
    for (const expectedBankVersion of [
      undefined,
      null,
      '0',
      -1,
      0.5,
      2_147_483_647,
    ]) {
      const body = await request(
        path,
        { ...input, expectedBankVersion },
        400,
        0,
      );
      assert.deepEqual(body.detail, { field: 'expectedBankVersion' });
    }
    for (const invalid of [
      { ...input, accountNumber: 123 },
      { ...input, accountNumber: 'a123' },
      { ...input, accountNumber: '1'.repeat(65) },
      { ...input, accountHolder: null },
      { ...input, accountHolder: ' ' },
      { ...input, accountHolder: 'x'.repeat(101) },
      { ...input, bankCode: 'invalid' },
      { ...input, verifyWithOpenBanking: true },
      { ...input, birthDate: '1990-01-01' },
      [],
      null,
    ])
      assert.equal(
        (await request(path, invalid, 400, 0)).code,
        'invalid_input',
      );
    await request(path, {}, 401, 0, '');
    await request(path, {}, 401, 0, 'forged');
  }
  await request('bank-account', { ...input, confirmRejoin: true }, 400, 0);
  await request('onboarding', { ...input, confirmRejoin: 'true' }, 400, 0);
  const onboarded = await request(
    'onboarding',
    { ...input, verifyWithOpenBanking: false },
    200,
    2,
  );
  assert.equal(readAccessToken(onboarded.data.accessToken)?.purpose, 'app');
  const token = onboarded.data.accessToken;
  const row = async () =>
    (
      await db.query(
        'SELECT bank_code,account_number,account_number_formatted,account_holder,bank_version FROM users WHERE id=$1',
        [session.userId],
      )
    ).rows[0];
  assert.deepEqual(await row(), {
    bank_code: '002',
    account_number: '03112345678901',
    account_number_formatted: '031-1234-5678-901',
    account_holder: '가계좌',
    bank_version: 1,
  });
  for (const [invalid, field] of [
    [{ ...input, bankCode: '999', expectedBankVersion: 1 }, 'bankCode'],
    [
      { ...input, accountNumber: '1'.repeat(17), expectedBankVersion: 1 },
      'accountNumber',
    ],
    [
      { ...input, accountHolder: '가'.repeat(41), expectedBankVersion: 1 },
      'accountHolder',
    ],
    [
      { ...input, accountHolder: '가\u200b', expectedBankVersion: 1 },
      'accountHolder',
    ],
  ] as const)
    assert.deepEqual(
      (await request('bank-account', invalid, 400, 1, token)).detail,
      { field },
    );
  const updated = await request(
    'bank-account',
    {
      bankCode: '092',
      accountNumber: '0000-01',
      accountHolder: ' 가계좌 ',
      expectedBankVersion: 1,
    },
    200,
    2,
    token,
  );
  assert.equal(updated.data.bankVersion, 2);
  assert.deepEqual(await row(), {
    bank_code: '092',
    account_number: '000001',
    account_number_formatted: '000001',
    account_holder: '가계좌',
    bank_version: 2,
  });
  assert.equal(
    (
      await request(
        'bank-account',
        { ...input, expectedBankVersion: 1 },
        409,
        2,
        token,
      )
    ).code,
    'bank_account_conflict',
  );
  assert.equal(
    (
      await request(
        'bank-account',
        input,
        401,
        1,
        createAccessToken(randomUUID(), randomUUID()),
      )
    ).code,
    'unauthorized',
  );
});
