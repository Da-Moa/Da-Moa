import { before } from 'node:test';
import { getPrismaClient } from '../support/domainTestSupport';
import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import test from 'node:test';
import {
  withReadTransaction,
  withWriteTransaction,
} from '../support/domainTestSupport';
import { getDatabasePool } from '../support/domainTestSupport';

const testUrl = process.env.TEST_DATABASE_URL;
if (
  !testUrl ||
  !['localhost', '127.0.0.1', '[::1]'].includes(new URL(testUrl).hostname) ||
  !new URL(testUrl).pathname.toLowerCase().includes('test')
) {
  throw new Error(
    'TEST_DATABASE_URL must name an isolated local test database',
  );
}
process.env.DATABASE_URL = testUrl;

test('PostgreSQL pool reuses connections, rolls back safely, and isolates concurrent transactions', async (t) => {
  const previousLog = process.env.DB_QUERY_LOG;
  process.env.DB_QUERY_LOG = 'true';
  t.after(() => {
    if (previousLog === undefined) delete process.env.DB_QUERY_LOG;
    else process.env.DB_QUERY_LOG = previousLog;
  });
  const logs: string[] = [];
  t.mock.method(console, 'info', (sql: string) => logs.push(sql));
  const pool = await getDatabasePool(testUrl);
  let queries = 0;
  const countQuery = () => {
    queries++;
  };
  channel('da-moa.db.query').subscribe(countQuery);
  t.after(() => channel('da-moa.db.query').unsubscribe(countQuery));
  const backend = () =>
    withReadTransaction(
      async (client) =>
        (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
    );
  const pid = await backend();
  assert.equal(await backend(), pid);
  assert.equal(
    queries,
    10,
    'each Prisma RepeatableRead/READ ONLY transaction uses five statements',
  );
  assert.equal(logs.length, 10);
  assert.equal(logs[0], 'SQL:\n    BEGIN');
  assert.match(logs[1], /SET TRANSACTION ISOLATION LEVEL REPEATABLE READ/);
  assert.match(logs[2], /SET TRANSACTION READ ONLY/);
  assert.match(logs[3], /pg_backend_pid\(\)/);
  assert.equal(logs[4], 'SQL:\n    COMMIT');
  assert.deepEqual(logs.slice(0, 5), logs.slice(5, 10));
  assert.equal(pool.totalCount, 1);
  assert.equal(pool.idleCount, 1);

  const failure = new Error('rollback probe');
  await assert.rejects(
    withWriteTransaction(async (client) => {
      await client.query('CREATE TEMP TABLE pool_rollback_probe (id integer)');
      await client.query('INSERT INTO pool_rollback_probe VALUES (1)');
      throw failure;
    }),
    (error) => error === failure,
  );
  const state = await withReadTransaction(
    async (client) =>
      (
        await client.query(
          "SELECT pg_backend_pid() AS pid, to_regclass('pg_temp.pool_rollback_probe')::text AS probe",
        )
      ).rows[0],
  );
  assert.equal(state.pid, pid);
  assert.equal(state.probe, null);
  const client = await pool.connect();
  try {
    assert.equal(
      (await client.query('SHOW statement_timeout')).rows[0].statement_timeout,
      '15s',
    );
    assert.equal(
      (await client.query('SHOW lock_timeout')).rows[0].lock_timeout,
      '10s',
    );
    assert.equal(
      (await client.query('SHOW transaction_read_only')).rows[0]
        .transaction_read_only,
      'off',
    );
  } finally {
    client.release();
  }

  let arrived = 0;
  let resume!: () => void;
  const ready = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const concurrent = () =>
    withReadTransaction(async (client) => {
      if (++arrived === 2) resume();
      await ready;
      assert.equal(
        (await client.query('SHOW statement_timeout')).rows[0]
          .statement_timeout,
        '15s',
      );
      assert.equal(
        (await client.query('SHOW lock_timeout')).rows[0].lock_timeout,
        '10s',
      );
      assert.equal(
        (await client.query('SHOW transaction_read_only')).rows[0]
          .transaction_read_only,
        'on',
      );
      return (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    });
  const pids = await Promise.all([concurrent(), concurrent()]);
  assert.notEqual(pids[0], pids[1]);
  assert.equal(pool.totalCount, 2);
  assert.equal(pool.idleCount, 2);

  await assert.rejects(
    withReadTransaction((client) =>
      client.query('SELECT $1::integer', ['private-account-value']),
    ),
    (error: { code?: string }) => error.code === '22P02',
  );
  assert.equal(logs.at(-1), 'SQL:\n    ROLLBACK');
  assert.doesNotMatch(
    logs.join('\n'),
    /private-account-value|db\.query\.(start|end)/,
  );
  assert.equal(logs.length, queries, 'every query must be logged exactly once');
});

before(async () => {
  await getPrismaClient(process.env.TEST_DATABASE_URL!);
});
