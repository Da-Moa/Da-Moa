import {
  mockPoolConnection,
  queryText,
  queryResult,
} from '../support/dbTestSupport.ts';
import { before } from 'node:test';
import { getPrismaClient } from '../support/domainTestSupport.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { HttpRequest as NextRequest } from '../../global/apiPayload/httpContext';
import {
  createAccessToken,
  currentTimestamp,
  readAccessToken,
} from '../../global/auth/native.ts';
import { signInKakao } from '../support/domainTestSupport.ts';
import {
  completeOnboarding,
  updateBankAccount,
  withdrawAccount,
} from '../support/domainTestSupport.ts';
import {
  findUser,
  saveBankAccount,
  saveOnboarding,
} from '../support/domainTestSupport.ts';
import { normalizeBankAccountInput } from '../../../shared/domain/user/index.ts';
import { createDatabaseClient } from '../../global/database/db.ts';
import { withDatabaseConnection } from '../support/domainTestSupport.ts';
import { getDatabasePool } from '../support/domainTestSupport.ts';
import { getMeResponse as GET } from '../support/httpTestSupport.ts';
import { getBankAccountResponse as PUT } from '../support/httpTestSupport.ts';
import { applyMigrations } from '../../../../scripts/migrations.mjs';
import { completeTestOnboarding } from './bankTestSupport.ts';
import { uuidV7 } from '../../../shared/uuid.ts';
import { createGroup } from '../support/domainTestSupport.ts';
import { createRound } from '../support/domainTestSupport.ts';

const database = process.env.TEST_DATABASE_URL;
if (
  !database ||
  !['localhost', '127.0.0.1', '[::1]'].includes(new URL(database).hostname) ||
  !new URL(database).pathname.toLowerCase().includes('test')
)
  throw new Error(
    'TEST_DATABASE_URL must name an isolated local test database',
  );
process.env.DATABASE_URL = database;
process.env.AUTH_JWT_SECRET ||= 'isolated-user-test-secret-at-least-32-bytes';

test('unified Nonghyup input preserves institution codes and verified legacy accounts with two SQL writes', async (t) => {
  const client = createDatabaseClient(database);
  await client.connect();
  const previousLog = process.env.DB_QUERY_LOG;
  let statements: string[] = [];
  try {
    await applyMigrations(client);
    for (const [bankCode, bankName, accountNumber] of [
      ['011', 'NH농협은행', '3010123456781'],
      ['012', '지역농축협', '3510221772213'],
    ]) {
      const limited = await signInKakao(`unified-nonghyup:${randomUUID()}`, {
        displayName: '농협 검증',
        email: null,
        profileImageUrl: null,
      });
      const input = {
        bankCode: '011',
        accountNumber,
        accountHolder: '농협 검증',
        expectedBankVersion: 0,
      };
      const session = await completeOnboarding(
        readAccessToken(limited.accessToken),
        input,
      );
      await client.query(
        "UPDATE users SET bank_name=$2, bank_verified_at=7, bank_verification_tran_id='test-nonghyup-verification' WHERE id=$1",
        [session.userId, bankName],
      );
      process.env.DB_QUERY_LOG = 'true';
      t.mock.method(console, 'info', (message: string) => {
        statements.push(
          message
            .replace(/^SQL:\s*/, '')
            .replace(/\s+/g, ' ')
            .trim(),
        );
      });
      statements = [];
      const response = await GET(
        new NextRequest('http://localhost/api/me', {
          headers: { authorization: `Bearer ${session.accessToken}` },
        }),
      );
      assert.equal(response.status, 200);
      const me = (await response.json()).data;
      assert.equal(me.bankAccount.bankName, '농협');
      assert.equal(me.bankAccount.bankCode, bankCode);
      assert.equal(me.bankAccount.verifiedAt, 7);
      assert.equal(statements.length, 1);
      statements = [];
      await updateBankAccount(
        readAccessToken(session.accessToken),
        randomUUID(),
        { ...input, expectedBankVersion: 1 },
      );
      assert.equal(statements.length, 2);
      assert.match(
        statements[0],
        /^SELECT .* FROM "public"\."users" WHERE .*"id" = \$1/,
      );
      assert.match(statements[1], /^UPDATE users SET /);
      const saved = (
        await client.query(
          'SELECT bank_name, bank_code, account_number, bank_verified_at, bank_version FROM users WHERE id=$1',
          [session.userId],
        )
      ).rows[0];
      assert.equal(saved.bank_name, '농협');
      assert.equal(saved.bank_code, bankCode);
      assert.equal(saved.account_number, accountNumber);
      assert.equal(saved.bank_verified_at, '7');
      assert.equal(saved.bank_version, 2);
      if (previousLog === undefined) delete process.env.DB_QUERY_LOG;
      else process.env.DB_QUERY_LOG = previousLog;
      t.mock.restoreAll();
    }
  } finally {
    if (previousLog === undefined) delete process.env.DB_QUERY_LOG;
    else process.env.DB_QUERY_LOG = previousLog;
    await client.end();
  }
});

test('withdrawal locks before checks and releases the transaction lock on commit and rollback', async (t) => {
  const client = createDatabaseClient(database);
  await client.connect();
  const previousLog = process.env.DB_QUERY_LOG;
  const code = (expected: string) => (error: unknown) =>
    (error as { code?: string }).code === expected;
  const member = async () => {
    const signup = await signInKakao(`user-withdraw:${randomUUID()}`, {
      displayName: '탈퇴 검증',
      email: null,
      profileImageUrl: null,
    });
    const session = await completeTestOnboarding(
      readAccessToken(signup.accessToken),
      {
        bankName: '검증은행',
        accountNumber: '001234',
        accountHolder: '탈퇴 검증',
      },
    );
    return readAccessToken(session.accessToken)!;
  };
  try {
    await applyMigrations(client);
    const owner = await member(),
      participant = await member(),
      alone = await member();
    const group = await createGroup(owner, uuidV7(), {
      name: '탈퇴 검증 모임',
    });
    const second = await createGroup(owner, uuidV7(), {
      name: '탈퇴 검증 두 번째 모임',
    });
    await client.query(
      'INSERT INTO group_members(group_id,user_id,joined_at) VALUES($1,$2,1)',
      [group.id, participant.userId],
    );
    const round = await createRound(owner, uuidV7(), group.id, {
      name: '탈퇴 차단',
      participantIds: [owner.userId, participant.userId],
    });
    await client.query(
      'UPDATE round_members SET excluded_at=1 WHERE round_id=$1 AND user_id=$2',
      [round.id, participant.userId],
    );

    process.env.DB_QUERY_LOG = 'true';
    let statements: string[] = [];
    t.mock.method(console, 'info', (message: string) => {
      statements.push(
        message
          .replace(/^SQL:\s*/, '')
          .replace(/\s+/g, ' ')
          .trim(),
      );
    });
    const trace = async <T>(
      count: number,
      work: () => Promise<T>,
      ending = 'ROLLBACK',
    ) => {
      statements = [];
      const result = await work();
      assert.equal(statements.length, count, statements.join('\n'));
      assert.equal(statements[0], 'BEGIN');
      assert.equal(
        statements[1],
        'SELECT pg_advisory_xact_lock(1684106607)::text',
      );
      assert.equal(statements.at(-1), ending);
      assert.doesNotMatch(
        statements.join('\n'),
        /pg_advisory_lock\(|pg_advisory_unlock|FOR UPDATE|FOR SHARE|mutation_requests/,
      );
      if (count >= 4)
        assert.match(
          statements[2],
          /^SELECT .* FROM "public"\."users" WHERE .*"id" = \$1/,
        );
      if (count >= 5)
        assert.match(
          statements[3],
          /^SELECT .* FROM round_members rm JOIN rounds/,
        );
      if (count === 6)
        assert.match(statements[4], /^WITH unfinished AS MATERIALIZED/);
      assert.equal(
        (
          await client.query(
            'SELECT pg_try_advisory_lock(1684106607) AS acquired',
          )
        ).rows[0].acquired,
        true,
        'another connection can acquire the same lock after commit or rollback',
      );
      await client.query('SELECT pg_advisory_unlock(1684106607)');
      return result;
    };
    await trace(3, () =>
      assert.rejects(withdrawAccount(null), code('unauthorized')),
    );
    await trace(5, () =>
      assert.rejects(withdrawAccount(participant), (error) => {
        assert.equal((error as { code: string }).code, 'unfinished_rounds');
        assert.equal(
          (error as { details: { rounds: { id: string }[] } }).details.rounds[0]
            .id,
          round.id,
        );
        return true;
      }),
    );
    await client.query('DELETE FROM rounds WHERE id=$1', [round.id]);

    // A failure in membership exit must also cancel the user soft delete.
    const pool = await getDatabasePool(database);
    const connect = pool.connect.bind(pool);
    const connectionMock = mockPoolConnection(t, pool, async () => {
      const borrowed = await connect();
      const queryMock = t.mock.method(
        borrowed,
        'query',
        new Proxy(borrowed.query, {
          apply(target, receiver, args) {
            return queryResult(args, (args) => {
              if (
                queryText(args[0]).includes('WITH unfinished AS MATERIALIZED')
              ) {
                queryMock.mock.restore();
                const text = queryText(args[0]).replace(
                  'RETURNING group_id',
                  'RETURNING (length(group_id) / (length(group_id) - length(group_id)))::text AS group_id',
                );
                args[0] =
                  typeof args[0] === 'string' ? text : { ...args[0], text };
              }
              return Reflect.apply(target, receiver, args);
            });
          },
        }),
      );
      return borrowed;
    });
    await trace(6, () =>
      assert.rejects(
        withdrawAccount(owner),
        (error) => (error as { code: string }).code === '22012',
      ),
    );
    connectionMock.mock.restore();
    const preserved = (
      await client.query(
        `SELECT u.deleted_at, COUNT(*) FILTER (WHERE m.left_at IS NULL)::int AS memberships
      FROM users u JOIN group_members m ON m.user_id=u.id WHERE u.id=$1 GROUP BY u.id`,
        [owner.userId],
      )
    ).rows[0];
    assert.deepEqual(preserved, { deleted_at: null, memberships: 2 });

    const departed = await trace(6, () => withdrawAccount(owner), 'COMMIT');
    assert.deepEqual(
      new Set(departed.groupIds),
      new Set([group.id, second.id]),
    );
    const saved = (
      await client.query(
        `SELECT u.deleted_at, u.account_number,
      bool_and(m.left_at=u.deleted_at) AS same_exit_time FROM users u JOIN group_members m ON m.user_id=u.id
      WHERE u.id=$1 GROUP BY u.id`,
        [owner.userId],
      )
    ).rows[0];
    assert.notEqual(saved.deleted_at, null);
    assert.equal(saved.account_number, '001234');
    assert.equal(saved.same_exit_time, true);
    await trace(4, () =>
      assert.rejects(withdrawAccount(owner), code('unauthorized')),
    );
    assert.deepEqual(
      (await trace(6, () => withdrawAccount(alone), 'COMMIT')).groupIds,
      [],
    );
    statements = [];
    const withdrawals = await Promise.allSettled([
      withdrawAccount(participant),
      withdrawAccount(participant),
    ]);
    assert.equal(
      withdrawals.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    const rejected = withdrawals.find(
      (result) => result.status === 'rejected',
    ) as PromiseRejectedResult;
    assert.equal(rejected.reason.code, 'unauthorized');
    assert.equal(pool.idleCount, pool.totalCount);
  } finally {
    if (previousLog === undefined) delete process.env.DB_QUERY_LOG;
    else process.env.DB_QUERY_LOG = previousLog;
    await client.end();
  }
});

test('GET /api/me uses one AUTH SELECT without transaction SQL for app, onboarding and rejected user states', async (t) => {
  const client = createDatabaseClient(database);
  await client.connect();
  const previousLog = process.env.DB_QUERY_LOG;
  try {
    await applyMigrations(client);
    const profile = {
      displayName: '내 정보 검증',
      email: null,
      profileImageUrl: null,
    };
    const limited = await signInKakao(`user-me:${randomUUID()}`, profile);
    const appSignup = await signInKakao(`user-me:${randomUUID()}`, profile);
    const app = await completeTestOnboarding(
      readAccessToken(appSignup.accessToken),
      {
        bankName: '검증은행',
        accountNumber: '001234',
        accountHolder: profile.displayName,
      },
    );
    const rejoining = await signInKakao(`user-me:${randomUUID()}`, profile);
    await client.query('UPDATE users SET deleted_at=1 WHERE id=$1', [
      rejoining.userId,
    ]);

    process.env.DB_QUERY_LOG = 'true';
    let statements: string[] = [];
    t.mock.method(console, 'info', (message: string) => {
      statements.push(
        message
          .replace(/^SQL:\s*/, '')
          .replace(/\s+/g, ' ')
          .trim(),
      );
    });
    for (const [token, status, purpose] of [
      [app.accessToken, 200, 'app'],
      [limited.accessToken, 200, 'onboarding'],
      [appSignup.accessToken, 401, undefined],
      [rejoining.accessToken, 200, 'onboarding'],
      [createAccessToken(rejoining.userId, randomUUID()), 401, undefined],
      [createAccessToken(randomUUID(), randomUUID()), 401, undefined],
    ] as const) {
      statements = [];
      const response = await GET(
        new NextRequest('http://localhost/api/me', {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      assert.equal(response.status, status);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.equal(statements.length, 1, statements.join('\n'));
      assert.match(
        statements[0],
        /^SELECT .* FROM "public"\."users" WHERE .*"id" = \$1/,
      );
      assert.doesNotMatch(
        statements[0],
        /\b(?:BEGIN|COMMIT|ROLLBACK|SET)\b|pg_advisory|FOR UPDATE|FOR SHARE/,
      );
      const body = await response.json();
      if (status === 200) {
        assert.equal(body.data.purpose, purpose);
        assert.equal(body.data.displayName, profile.displayName);
        assert.equal(
          body.data.bankAccount?.accountNumber ?? null,
          purpose === 'app' ? '001234' : null,
        );
      } else assert.equal(body.error, 'unauthorized');
    }
    statements = [];
    assert.equal(
      (await GET(new NextRequest('http://localhost/api/me'))).status,
      401,
    );
    assert.equal(statements.length, 0);
    const pool = await getDatabasePool(database);
    assert.equal(
      pool.idleCount,
      pool.totalCount,
      'all borrowed connections are returned after success and rejection',
    );
  } finally {
    if (previousLog === undefined) delete process.env.DB_QUERY_LOG;
    else process.env.DB_QUERY_LOG = previousLog;
    await client.end();
  }
});

test('bank account uses AUTH then validation then conditional UPDATE; one concurrent request wins and conflicts return 409', async (t) => {
  const client = createDatabaseClient(database);
  await client.connect();
  const previousLog = process.env.DB_QUERY_LOG;
  const input = {
    bankCode: '004',
    accountNumber: '001234',
    accountHolder: '계좌 검증',
    expectedBankVersion: 1,
  };
  const code = (expected: string) => (error: unknown) =>
    (error as { code?: string }).code === expected;
  let statements: string[] = [];
  try {
    await applyMigrations(client);
    const signup = await signInKakao(`user-bank:${randomUUID()}`, {
      displayName: input.accountHolder,
      email: null,
      profileImageUrl: null,
    });
    const app = await completeOnboarding(readAccessToken(signup.accessToken), {
      ...input,
      expectedBankVersion: 0,
    });
    const access = readAccessToken(app.accessToken);
    process.env.DB_QUERY_LOG = 'true';
    t.mock.method(console, 'info', (message: string) => {
      statements.push(
        message
          .replace(/^SQL:\s*/, '')
          .replace(/\s+/g, ' ')
          .trim(),
      );
    });
    const trace = async <T>(count: number, work: () => Promise<T>) => {
      statements = [];
      const result = await work();
      assert.equal(statements.length, count, statements.join('\n'));
      assert.doesNotMatch(
        statements.join('\n'),
        /^(?:BEGIN|COMMIT|ROLLBACK|SET)\b|pg_advisory|FOR UPDATE|FOR SHARE|mutation_requests/m,
      );
      if (count)
        assert.match(
          statements[0],
          /^SELECT .* FROM "public"\."users" WHERE .*"id" = \$1/,
        );
      if (count === 2)
        assert.match(
          statements[1],
          /^UPDATE users SET .* WHERE id = \$1 AND bank_version = \$8 AND deleted_at IS NULL AND onboarding_completed_at IS NOT NULL$/,
        );
      return result;
    };
    await trace(0, () =>
      assert.rejects(
        updateBankAccount(null, randomUUID(), input),
        code('unauthorized'),
      ),
    );
    await trace(0, () =>
      assert.rejects(
        updateBankAccount(access, randomUUID(), {
          ...input,
          bankCode: 'invalid',
        }),
        code('invalid_input'),
      ),
    );
    await trace(0, () =>
      assert.rejects(
        updateBankAccount(access, randomUUID(), {
          ...input,
          accountNumber: 'abc',
        }),
        code('invalid_input'),
      ),
    );
    await trace(1, () =>
      assert.rejects(
        updateBankAccount(access, 'invalid', input),
        code('invalid_request_key'),
      ),
    );
    await trace(1, () =>
      assert.rejects(
        updateBankAccount(
          readAccessToken(signup.accessToken),
          randomUUID(),
          input,
        ),
        code('unauthorized'),
      ),
    );
    await client.query(
      "UPDATE users SET bank_verified_at=1, bank_verification_tran_id='test-verification' WHERE id=$1",
      [app.userId],
    );
    const key = randomUUID();
    assert.deepEqual(
      await trace(2, () => updateBankAccount(access, key, input)),
      { id: app.userId, bankVersion: 2 },
    );
    assert.equal(
      (
        await client.query('SELECT bank_verified_at FROM users WHERE id=$1', [
          app.userId,
        ])
      ).rows[0].bank_verified_at,
      '1',
    );
    const conflict = await trace(2, () =>
      PUT(
        new NextRequest('http://localhost/api/me/bank-account', {
          method: 'PUT',
          headers: {
            origin: 'http://localhost',
            authorization: `Bearer ${app.accessToken}`,
            'Idempotency-Key': key,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(input),
        }),
      ),
    );
    assert.equal(conflict.status, 409);
    const body = await conflict.json();
    assert.equal(body.error, 'bank_account_conflict');
    assert.match(body.message, /최신 계좌/);

    statements = [];
    const outcomes = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) =>
        updateBankAccount(access, randomUUID(), {
          ...input,
          accountNumber: `00123${index}`,
          expectedBankVersion: 2,
        }),
      ),
    );
    assert.equal(
      outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
      1,
    );
    for (const outcome of outcomes)
      if (outcome.status === 'rejected')
        assert.equal(outcome.reason.code, 'bank_account_conflict');
    assert.equal(statements.length, 12);
    assert.doesNotMatch(
      statements.join('\n'),
      /^(?:BEGIN|COMMIT|ROLLBACK|SET)\b|pg_advisory|FOR UPDATE|FOR SHARE|mutation_requests/m,
    );
    const winner = outcomes.findIndex(
      (outcome) => outcome.status === 'fulfilled',
    );
    const saved = (
      await client.query(
        'SELECT bank_version, account_number, bank_verified_at FROM users WHERE id=$1',
        [app.userId],
      )
    ).rows[0];
    assert.equal(Number(saved.bank_version), 3);
    assert.equal(saved.account_number, `00123${winner}`);
    assert.equal(saved.bank_verified_at, winner === 4 ? '1' : null);

    const normalized = normalizeBankAccountInput({
      ...input,
      expectedBankVersion: 3,
    });
    for (const state of [
      'deleted_at=1',
      'deleted_at=NULL, onboarding_completed_at=NULL',
    ]) {
      await client.query(`UPDATE users SET ${state} WHERE id=$1`, [app.userId]);
      assert.equal(
        await withDatabaseConnection((connection) =>
          saveBankAccount(
            connection,
            app.userId,
            normalized,
            currentTimestamp(),
          ),
        ),
        false,
        'a user withdrawn or no longer onboarded after AUTH cannot be updated',
      );
    }
    const pool = await getDatabasePool(database);
    assert.equal(pool.idleCount, pool.totalCount);
  } finally {
    if (previousLog === undefined) delete process.env.DB_QUERY_LOG;
    else process.env.DB_QUERY_LOG = previousLog;
    await client.end();
  }
});

test('onboarding uses AUTH + conditional UPDATE; concurrent signup/rejoin has one winner even at the same timestamp', async (t) => {
  const client = createDatabaseClient(database);
  await client.connect();
  const previousLog = process.env.DB_QUERY_LOG;
  const profile = {
    displayName: '온보딩 검증',
    email: null,
    profileImageUrl: null,
  };
  const input = {
    bankCode: '004',
    accountNumber: '001234',
    accountHolder: profile.displayName,
    expectedBankVersion: 0,
  };
  const code = (expected: string) => (error: unknown) =>
    (error as { code?: string }).code === expected;
  let statements: string[] = [];
  try {
    await applyMigrations(client);
    const signup = await signInKakao(
      `user-onboarding:${randomUUID()}`,
      profile,
    );
    const access = readAccessToken(signup.accessToken);
    process.env.DB_QUERY_LOG = 'true';
    t.mock.method(console, 'info', (message: string) => {
      statements.push(
        message
          .replace(/^SQL:\s*/, '')
          .replace(/\s+/g, ' ')
          .trim(),
      );
    });
    const trace = async <T>(count: number, work: () => Promise<T>) => {
      statements = [];
      const result = await work();
      assert.equal(statements.length, count, statements.join('\n'));
      assert.doesNotMatch(
        statements.join('\n'),
        /^(?:BEGIN|COMMIT|ROLLBACK|SET)\b|pg_advisory|FOR UPDATE|FOR SHARE/m,
      );
      if (count)
        assert.match(
          statements[0],
          /^SELECT .* FROM "public"\."users" WHERE .*"id" = \$1/,
        );
      if (count === 2)
        assert.match(
          statements[1],
          /^UPDATE "public"\."users" SET .* WHERE .*"id" = \$\d+.*"updated_at" = \$\d+.*"bank_version" = \$\d+/,
        );
      return result;
    };
    await trace(0, () =>
      assert.rejects(completeOnboarding(null, input), code('unauthorized')),
    );
    await trace(0, () =>
      assert.rejects(
        completeOnboarding(access, { ...input, bankCode: 'invalid' }),
        code('invalid_input'),
      ),
    );
    await trace(1, () =>
      assert.rejects(
        completeOnboarding(access, { ...input, expectedBankVersion: 1 }),
        code('bank_account_conflict'),
      ),
    );
    const secret = process.env.AUTH_JWT_SECRET;
    delete process.env.AUTH_JWT_SECRET;
    try {
      await trace(1, () =>
        assert.rejects(completeOnboarding(access, input), /AUTH_JWT_SECRET/),
      );
    } finally {
      process.env.AUTH_JWT_SECRET = secret;
    }
    const app = await trace(2, () => completeOnboarding(access, input));
    assert.equal(readAccessToken(app.accessToken)?.purpose, 'app');
    await trace(1, () =>
      assert.rejects(completeOnboarding(access, input), code('unauthorized')),
    );
    await trace(1, () =>
      assert.rejects(
        completeOnboarding(readAccessToken(app.accessToken), {
          ...input,
          expectedBankVersion: 1,
        }),
        code('already_onboarded'),
      ),
    );

    const rejoin = await signInKakao(
      `user-onboarding:${randomUUID()}`,
      profile,
    );
    await client.query('UPDATE users SET deleted_at=1 WHERE id=$1', [
      rejoin.userId,
    ]);
    await trace(1, () =>
      assert.rejects(
        completeOnboarding(readAccessToken(rejoin.accessToken), input),
        code('rejoin_confirmation_required'),
      ),
    );
    await trace(2, () =>
      completeOnboarding(readAccessToken(rejoin.accessToken), {
        ...input,
        confirmRejoin: true,
      }),
    );

    for (const rejoining of [false, true]) {
      const limited = await signInKakao(
        `user-onboarding-race:${randomUUID()}`,
        profile,
      );
      if (rejoining)
        await client.query(
          `UPDATE users SET deleted_at=1, onboarding_completed_at=1,
        bank_name='국민은행', account_number='999', account_holder=$2, bank_updated_at=1,
        bank_code='004', bank_verified_at=1, bank_verification_tran_id='test-verification', bank_version=3 WHERE id=$1`,
          [limited.userId, profile.displayName],
        );
      const bank = {
        ...input,
        expectedBankVersion: rejoining ? 3 : 0,
        confirmRejoin: rejoining,
      };
      statements = [];
      const outcomes = await Promise.allSettled(
        Array.from({ length: 6 }, (_, index) =>
          completeOnboarding(readAccessToken(limited.accessToken), {
            ...bank,
            accountNumber: `00123${index}`,
          }),
        ),
      );
      const winners = outcomes.filter(
        (outcome) => outcome.status === 'fulfilled',
      );
      assert.equal(winners.length, 1);
      for (const outcome of outcomes)
        if (outcome.status === 'rejected')
          assert.ok(
            ['unauthorized', 'bank_account_conflict'].includes(
              outcome.reason.code,
            ),
          );
      assert.doesNotMatch(
        statements.join('\n'),
        /^(?:BEGIN|COMMIT|ROLLBACK|SET)\b|pg_advisory|FOR UPDATE|FOR SHARE/m,
      );
      const winner = outcomes.findIndex(
        (outcome) => outcome.status === 'fulfilled',
      );
      const saved = (
        await client.query(
          'SELECT bank_version, account_number, deleted_at, bank_verified_at FROM users WHERE id=$1',
          [limited.userId],
        )
      ).rows[0];
      assert.equal(Number(saved.bank_version), bank.expectedBankVersion + 1);
      assert.equal(saved.account_number, `00123${winner}`);
      assert.equal(saved.deleted_at, null);
      assert.equal(saved.bank_verified_at, null);

      // Keep updated_at unchanged to prove second-resolution timestamps cannot admit a second save.
      await client.query(
        'UPDATE users SET deleted_at=$2, updated_at=$2 WHERE id=$1',
        [limited.userId, currentTimestamp()],
      );
      const snapshot = (await withDatabaseConnection((connection) =>
        findUser(connection, limited.userId),
      ))!;
      const normalized = normalizeBankAccountInput({
        ...bank,
        expectedBankVersion: Number(snapshot.bank_version),
      });
      await client.query(
        'UPDATE users SET updated_at=updated_at+1 WHERE id=$1',
        [limited.userId],
      );
      assert.equal(
        await withDatabaseConnection((connection) =>
          saveOnboarding(
            connection,
            limited.userId,
            normalized,
            Number(snapshot.updated_at),
            Number(snapshot.updated_at),
          ),
        ),
        false,
        'a changed AUTH snapshot must be rejected',
      );
      await client.query('UPDATE users SET updated_at=$2 WHERE id=$1', [
        limited.userId,
        snapshot.updated_at,
      ]);
      const savedCopies = await Promise.all(
        Array.from({ length: 6 }, () =>
          withDatabaseConnection((connection) =>
            saveOnboarding(
              connection,
              limited.userId,
              normalized,
              Number(snapshot.updated_at),
              Number(snapshot.updated_at),
            ),
          ),
        ),
      );
      assert.equal(savedCopies.filter(Boolean).length, 1);
    }
    const pool = await getDatabasePool(database);
    assert.equal(pool.idleCount, pool.totalCount);
  } finally {
    if (previousLog === undefined) delete process.env.DB_QUERY_LOG;
    else process.env.DB_QUERY_LOG = previousLog;
    await client.end();
  }
});

before(async () => {
  await getPrismaClient(process.env.TEST_DATABASE_URL!);
});
