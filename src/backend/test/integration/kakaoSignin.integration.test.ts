import { before } from 'node:test';
import { getPrismaClient } from '../support/domainTestSupport.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import { signInKakao } from '../support/domainTestSupport.ts';
import { readAccessToken } from '../support/legacyTokenTestSupport.ts';
import { withdrawAccount } from '../support/domainTestSupport.ts';
import { AppError } from '../../global/apiPayload/errors.ts';
import { getDatabasePool } from '../support/domainTestSupport.ts';
import { completeTestOnboarding } from '../support/bankTestSupport.ts';
import { applyMigrations } from '../../../../scripts/migrations.mjs';

const testUrl = process.env.TEST_DATABASE_URL;
if (
  !testUrl ||
  !['localhost', '127.0.0.1', '[::1]'].includes(new URL(testUrl).hostname) ||
  !new URL(testUrl).pathname.toLowerCase().includes('test')
)
  throw new Error(
    'TEST_DATABASE_URL must name an isolated local test database',
  );
process.env.DATABASE_URL = testUrl;
process.env.AUTH_JWT_SECRET ||=
  'isolated-kakao-signin-test-secret-at-least-32-bytes';

test('Kakao sign-in creates only missing provider identities with one SQL and no explicit transaction or lock', async (t) => {
  const db = new pg.Client({ connectionString: testUrl });
  await db.connect();
  const oldQueryLog = process.env.DB_QUERY_LOG;
  try {
    await applyMigrations(db);
    const profile = {
      displayName: '가입 검증',
      email: 'signup@example.test',
      profileImageUrl: 'https://profiles.example.test/signup.png',
    };
    const subject = `kakao-signin:${randomUUID()}`;
    // A different provider with the same UID must not prevent a Kakao signup.
    await db.query(
      `INSERT INTO users(id, provider, provider_subject, created_at, updated_at)
      VALUES($1, 'test', $2, 1, 1)`,
      [randomUUID(), subject],
    );
    let statements: string[] = [];
    process.env.DB_QUERY_LOG = 'true';
    t.mock.method(console, 'info', (message: string) => {
      statements.push(
        message
          .replace(/^SQL:\s*/, '')
          .replace(/\s+/g, ' ')
          .trim(),
      );
    });
    const pool = await getDatabasePool(testUrl);
    const assertOneStatement = () => {
      assert.equal(statements.length, 1);
      assert.match(
        statements[0],
        /INSERT INTO users.*WHERE NOT EXISTS.*ON CONFLICT \(provider, provider_subject\) DO NOTHING/,
      );
      assert.doesNotMatch(
        statements[0],
        /\b(BEGIN|COMMIT|ROLLBACK|UPDATE|SET)\b|pg_advisory|FOR SHARE/,
      );
      assert.equal(
        pool.idleCount,
        pool.totalCount,
        'return connections after both success and failure',
      );
    };
    const trace = async <T>(work: () => Promise<T>) => {
      statements = [];
      try {
        return await work();
      } finally {
        assertOneStatement();
      }
    };
    const signup = await trace(() => signInKakao(subject, profile));
    assert.equal(signup.purpose, 'onboarding');
    const original = (
      await db.query('SELECT * FROM users WHERE id=$1', [signup.userId])
    ).rows[0];
    assert.equal(original.display_name, profile.displayName);
    assert.equal(original.email, profile.email);
    assert.equal(original.profile_image_url, profile.profileImageUrl);
    const changedProfile = {
      displayName: '변경 요청',
      email: 'changed@example.test',
      profileImageUrl: 'https://profiles.example.test/changed.png',
    };
    const again = await trace(() => signInKakao(subject, changedProfile));
    assert.equal(again.userId, signup.userId);
    assert.equal(again.purpose, 'onboarding');
    assert.deepEqual(
      (await db.query('SELECT * FROM users WHERE id=$1', [signup.userId]))
        .rows[0],
      original,
      'existing profiles and timestamps are not updated',
    );
    assert.equal(
      (
        await db.query(
          'SELECT count(*)::int AS count FROM users WHERE provider_subject=$1',
          [subject],
        )
      ).rows[0].count,
      2,
    );

    const registered = await completeTestOnboarding(
      readAccessToken(signup.accessToken),
      {
        bankName: '검증은행',
        accountNumber: '12340312345678',
        accountHolder: '가입 검증',
      },
    );
    const login = await trace(() => signInKakao(subject, changedProfile));
    assert.equal(login.userId, signup.userId);
    assert.equal(login.purpose, 'app');
    // Removing the global lock must allow sign-in even while another operation holds it.
    await db.query('SELECT pg_advisory_lock(1684106607)');
    try {
      const unblocked = await trace(() => signInKakao(subject, profile));
      assert.equal(unblocked.purpose, 'app');
    } finally {
      await db.query('SELECT pg_advisory_unlock(1684106607)');
    }
    statements = [];
    const sessions = await Promise.all(
      Array.from({ length: 6 }, () => signInKakao(subject, profile)),
    );
    assert.equal(statements.length, 6);
    assert.ok(
      sessions.every(
        (session) =>
          session.userId === signup.userId && session.purpose === 'app',
      ),
    );
    await withdrawAccount(readAccessToken(registered.accessToken));
    const beforeRejoin = (
      await db.query('SELECT * FROM users WHERE id=$1', [signup.userId])
    ).rows[0];
    const rejoin = await trace(() => signInKakao(subject, changedProfile));
    assert.equal(rejoin.userId, signup.userId);
    assert.equal(rejoin.purpose, 'onboarding');
    assert.deepEqual(
      (await db.query('SELECT * FROM users WHERE id=$1', [signup.userId]))
        .rows[0],
      beforeRejoin,
    );

    // Force a unique conflict with a row outside the losing statement's snapshot.
    const racingSubject = `kakao-signin-race:${randomUUID()}`,
      winnerId = randomUUID();
    await db.query('BEGIN');
    try {
      await db.query(
        `INSERT INTO users(id, provider, provider_subject, created_at, updated_at)
        VALUES($1, 'kakao', $2, 1, 1)`,
        [winnerId, racingSubject],
      );
      statements = [];
      const loser = signInKakao(racingSubject, profile);
      const rejected = assert.rejects(
        loser,
        (error) =>
          error instanceof AppError && error.code === 'sign_in_conflict',
      );
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const result =
          await db.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND pid<>pg_backend_pid()
            AND wait_event='transactionid' AND query LIKE '%WITH existing AS MATERIALIZED%') AS waiting`);
        if (result.rows[0].waiting) {
          waiting = true;
          break;
        }
        await delay(10);
      }
      await db.query('COMMIT');
      await rejected;
      assert.ok(
        waiting,
        'the competing signup must have reached the unique conflict',
      );
      assertOneStatement();
      const retry = await trace(() => signInKakao(racingSubject, profile));
      assert.equal(retry.userId, winnerId);
      assert.equal(retry.purpose, 'onboarding');
      assert.equal(
        (
          await db.query(
            `SELECT count(*)::int AS count FROM users
        WHERE provider='kakao' AND provider_subject=$1`,
            [racingSubject],
          )
        ).rows[0].count,
        1,
      );
    } finally {
      await db.query('ROLLBACK');
    }
    statements = [];
    await assert.rejects(signInKakao('', profile), /Kakao subject is required/);
    assert.equal(statements.length, 0);
  } finally {
    if (oldQueryLog === undefined) delete process.env.DB_QUERY_LOG;
    else process.env.DB_QUERY_LOG = oldQueryLog;
    await db.end();
  }
});

before(async () => {
  await getPrismaClient(process.env.TEST_DATABASE_URL!);
});
