import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import { createServer } from 'node:http';
import test, { before, after } from 'node:test';
import { createBackend } from '../../domain/main';
import type { INestApplication } from '@nestjs/common';
import { ReceiptWorker } from '../../domain/settle/index.ts';
import { createDatabaseClient } from '../../global/database/dbClient.mjs';
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

let app: INestApplication;
let origin: string;
before(async () => {
  ({ app } = await createBackend());
  await app.listen(0, '127.0.0.1');
  origin = await app.getUrl();
});
after(async () => {
  await app?.close();
});

test('individual health routes probe PostgreSQL and MinIO independently', async (t) => {
  let minioStatus = 200;
  const paths: string[] = [];
  const minio = createServer((request, response) => {
    paths.push(request.url!);
    response.writeHead(minioStatus).end();
  });
  await new Promise<void>((resolve) => minio.listen(0, '127.0.0.1', resolve));
  const address = minio.address() as { port: number };
  process.env.MINIO_ENDPOINT = `http://127.0.0.1:${address.port}`;
  const get = (check: string) =>
    fetch(`${origin}/api/health${check ? '/' + check : ''}`);
  try {
    minioStatus = 503;
    const previousLog = process.env.DB_QUERY_LOG;
    process.env.DB_QUERY_LOG = 'true';
    const sql: string[] = [];
    let queryCount = 0;
    const countQuery = () => {
      queryCount++;
    };
    channel('da-moa.db.query').subscribe(countQuery);
    const logger = t.mock.method(console, 'info', (message: string) => {
      sql.push(
        message
          .replace(/^SQL:\s*/, '')
          .replace(/\s+/g, ' ')
          .trim(),
      );
    });
    let database: Response;
    try {
      database = await get('database');
    } finally {
      channel('da-moa.db.query').unsubscribe(countQuery);
      logger.mock.restore();
      if (previousLog === undefined) delete process.env.DB_QUERY_LOG;
      else process.env.DB_QUERY_LOG = previousLog;
    }
    assert.equal(database.status, 200);
    assert.deepEqual(await database.json(), {
      status: 'ok',
      checks: { database: 'ok' },
    });
    assert.deepEqual(sql, ['SELECT 1']);
    assert.equal(
      queryCount,
      1,
      'DB health must count exactly one query in monitoring',
    );
    assert.deepEqual(paths, []);
    const failedMinio = await get('minio');
    assert.equal(failedMinio.status, 503);
    assert.deepEqual(await failedMinio.json(), {
      status: 'down',
      checks: { minio: 'down' },
    });
    assert.deepEqual(paths.sort(), [
      '/minio/health/cluster',
      '/minio/health/cluster/read',
    ]);

    minioStatus = 200;
    for (const [scope, databaseQueries, minioRequests] of [
      ['live', 0, 0],
      ['minio', 0, 2],
      ['dependencies', 1, 2],
      ['', 1, 2],
    ] as const) {
      const statements: string[] = [];
      let count = 0;
      const countStatement = () => {
        count++;
      };
      paths.length = 0;
      process.env.DB_QUERY_LOG = 'true';
      channel('da-moa.db.query').subscribe(countStatement);
      const log = t.mock.method(console, 'info', (message: string) => {
        statements.push(
          message
            .replace(/^SQL:\s*/, '')
            .replace(/\s+/g, ' ')
            .trim(),
        );
      });
      try {
        const response = await get(scope);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
        assert.equal(count, databaseQueries, `${scope || 'overall'} SQL count`);
        assert.deepEqual(statements, databaseQueries ? ['SELECT 1'] : []);
        assert.equal(paths.length, minioRequests);
      } finally {
        channel('da-moa.db.query').unsubscribe(countStatement);
        log.mock.restore();
        if (previousLog === undefined) delete process.env.DB_QUERY_LOG;
        else process.env.DB_QUERY_LOG = previousLog;
      }
    }
    process.env.DATABASE_URL = '';
    process.env.POSTGRES_URL = '';
    const healthyMinio = await get('minio');
    assert.equal(healthyMinio.status, 200);
    assert.deepEqual(await healthyMinio.json(), {
      status: 'ok',
      checks: { minio: 'ok' },
    });
    const failedDatabase = await get('database');
    assert.equal(failedDatabase.status, 503);
    assert.deepEqual(await failedDatabase.json(), {
      status: 'down',
      checks: { database: 'down' },
    });
  } finally {
    await new Promise<void>((resolve) => minio.close(() => resolve()));
  }
});

test('receipt worker probes distinguish startup, queue errors, dependencies and shutdown', async () => {
  process.env.DATABASE_URL = testUrl;
  const db = createDatabaseClient(testUrl);
  await db.connect();
  try {
    await applyMigrations(db);
  } finally {
    await db.end();
  }
  let minioStatus = 200;
  const minio = createServer((_request, response) =>
    response.writeHead(minioStatus).end(),
  );
  await new Promise<void>((resolve) => minio.listen(0, '127.0.0.1', resolve));
  Object.assign(process.env, {
    MINIO_ENDPOINT: `http://127.0.0.1:${(minio.address() as { port: number }).port}`,
    MINIO_BUCKET: 'worker-health-test',
    MINIO_ACCESS_KEY: 'test',
    MINIO_SECRET_KEY: 'test',
  });
  const get = (scope: string) => fetch(`${origin}/api/health/${scope}`);
  let runner: Awaited<ReturnType<ReceiptWorker['start']>> | undefined;
  try {
    assert.equal((await get('worker')).status, 503);
    runner = await app.get(ReceiptWorker).start();
    assert.equal((await get('worker')).status, 200);
    process.env.RECEIPT_WORKER_ENABLED = 'false';
    assert.equal((await get('worker')).status, 503);
    assert.equal((await get('worker/readyz')).status, 503);
    delete process.env.RECEIPT_WORKER_ENABLED;
    const workers = new Map<string, import('graphile-worker').Worker>();
    runner.events.on('worker:getJob:empty', ({ worker }) =>
      workers.set(worker.workerId, worker),
    );
    const deadline = Date.now() + 5000;
    while (workers.size < 2 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(workers.size, 2);
    assert.equal((await get('worker/readyz')).status, 200);
    for (const worker of workers.values())
      runner.events.emit('worker:getJob:error', {
        ctx: {} as never,
        worker,
        error: new Error('secret queue error'),
      });
    assert.equal(
      (await get('worker')).status,
      200,
      'a recoverable queue error must not fail liveness',
    );
    const queueDown = await get('worker/readyz');
    assert.equal(queueDown.status, 503);
    assert.equal((await queueDown.json()).checks.worker, 'down');
    const recoverDeadline = Date.now() + 5000;
    while (
      (await get('worker/readyz')).status !== 200 &&
      Date.now() < recoverDeadline
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await get('worker/readyz')).status, 200);
    delete process.env.MINIO_ACCESS_KEY;
    assert.equal(
      (await get('worker/readyz')).status,
      503,
      'storage configuration is required',
    );
    process.env.MINIO_ACCESS_KEY = 'test';
    minioStatus = 503;
    assert.equal((await get('worker')).status, 200);
    const storageDown = await get('worker/readyz');
    assert.equal(storageDown.status, 503);
    assert.equal((await storageDown.json()).checks.minio, 'down');
    minioStatus = 200;
    process.env.DATABASE_URL = '';
    const databaseDown = await get('worker/readyz');
    assert.equal(databaseDown.status, 503);
    assert.equal((await databaseDown.json()).checks.database, 'down');
    process.env.DATABASE_URL = testUrl;
    await runner.stop();
    await runner.promise;
    runner = undefined;
    assert.equal((await get('worker')).status, 503);
    assert.equal((await get('worker/readyz')).status, 503);
  } finally {
    if (runner) {
      await runner.stop();
      await runner.promise;
    }
    await new Promise<void>((resolve) => minio.close(() => resolve()));
  }
});
