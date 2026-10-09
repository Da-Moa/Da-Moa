import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { makeWorkerUtils } from 'graphile-worker';
import { createBackend } from '../../domain/main';
import { ReceiptWorker } from '../../domain/settle/service/receiptWorker';
import { SettleRepository } from '../../domain/settle/repository/settle.repository';
import { createDatabaseClient } from '../../global/database/db';
import { applyMigrations } from '../../../../scripts/migrations.mjs';

const testUrl = process.env.TEST_DATABASE_URL;
if (
  !testUrl ||
  !['localhost', '127.0.0.1', '[::1]'].includes(new URL(testUrl).hostname) ||
  !new URL(testUrl).pathname.includes('test')
)
  throw new Error('An isolated local test database is required');
process.env.DATABASE_URL = testUrl;
const databaseUrl = testUrl;

async function setup(t: TestContext) {
  const db = createDatabaseClient(databaseUrl);
  await db.connect();
  await applyMigrations(db);
  const utils = await makeWorkerUtils({ connectionString: testUrl });
  const blocked = new Set<string>();
  const active = new Set<string>();
  const cancelled = new Set<string>();
  const jobIds: string[] = [];
  const server = createServer((request, response) => {
    request.resume();
    const id = new URL(request.url!, 'http://localhost').pathname
      .split('/')
      .at(-1)!
      .replace(/\.avif$/, '');
    if (request.method === 'PUT' && blocked.has(id)) {
      active.add(id);
      response.on('close', () => {
        active.delete(id);
        cancelled.add(id);
      });
      return;
    }
    response.writeHead(request.method === 'DELETE' ? 204 : 200).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const previousEndpoint = process.env.MINIO_ENDPOINT;
  process.env.MINIO_ENDPOINT = `http://127.0.0.1:${address.port}`;
  let app: Awaited<ReturnType<typeof createBackend>>['app'] | undefined;
  t.after(async () => {
    try {
      await app?.close();
      await utils.completeJobs(jobIds);
    } finally {
      if (previousEndpoint === undefined) delete process.env.MINIO_ENDPOINT;
      else process.env.MINIO_ENDPOINT = previousEndpoint;
      await Promise.all([
        utils.release(),
        db.end(),
        new Promise<void>((resolve) => server.close(() => resolve())),
      ]);
    }
  });
  return {
    db,
    utils,
    active,
    cancelled,
    async app() {
      return (app ??= (await createBackend()).app);
    },
    async queue(stall: boolean) {
      const id = randomUUID(),
        key = `cancellation:${id}`;
      if (stall) blocked.add(id);
      const job = await utils.addJob(
        'store_receipt',
        {
          id,
          userId: randomUUID(),
          content: Buffer.from('SDK cancellation test').toString('base64'),
        },
        { jobKey: key, maxAttempts: 8 },
      );
      jobIds.push(String(job.id));
      return { id, jobId: job.id };
    },
  };
}

async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  timeout: number,
) {
  const end = Date.now() + timeout;
  while (!(await condition())) {
    assert.ok(
      Date.now() < end,
      'condition must become true within the deadline',
    );
    await delay(50);
  }
}

test(
  '멈춘 SDK 업로드 2건을 1분 후 취소하고 큐 락을 해제하여 다음 작업을 실행한다',
  { timeout: 90000 },
  async (t) => {
    const fixture = await setup(t);
    const first = await fixture.queue(true),
      second = await fixture.queue(true),
      next = await fixture.queue(false);
    const app = await fixture.app();
    const finished = t.mock.method(
      app.get(SettleRepository),
      'finishReceiptStorage',
    );
    const worker = app.get(ReceiptWorker);
    const started = Date.now();
    await worker.start();
    await waitUntil(() => fixture.active.size === 2, 10000);
    const waiting = (
      await fixture.db.query(
        'SELECT attempts,locked_by FROM graphile_worker._private_jobs WHERE id=$1',
        [next.jobId],
      )
    ).rows[0];
    assert.equal(waiting.attempts, 0);
    assert.equal(
      waiting.locked_by,
      null,
      'both slots are occupied before the timeout',
    );
    await waitUntil(async () => {
      const result = await fixture.db.query(
        'SELECT attempts,locked_by,last_error FROM graphile_worker._private_jobs WHERE id=ANY($1::bigint[])',
        [[first.jobId, second.jobId]],
      );
      return (
        fixture.cancelled.size === 2 &&
        result.rows.length === 2 &&
        result.rows.every(
          (row) => row.attempts === 1 && row.locked_by === null,
        ) &&
        (
          await fixture.db.query(
            'SELECT id FROM graphile_worker._private_jobs WHERE id=$1',
            [next.jobId],
          )
        ).rowCount === 0
      );
    }, 70000);
    const elapsed = Date.now() - started;
    assert.ok(
      elapsed >= 59000 && elapsed < 75000,
      `observed elapsed=${elapsed}ms`,
    );
    const retries = (
      await fixture.db.query(
        'SELECT attempts,max_attempts,run_at,last_error FROM graphile_worker._private_jobs WHERE id=ANY($1::bigint[])',
        [[first.jobId, second.jobId]],
      )
    ).rows;
    assert.ok(
      retries.every(
        (row) =>
          row.attempts === 1 &&
          row.max_attempts === 8 &&
          new Date(row.run_at).getTime() > Date.now(),
      ),
    );
    assert.ok(
      retries.every((row) => /timed out after 60 seconds/.test(row.last_error)),
    );
    assert.equal(
      finished.mock.callCount(),
      1,
      'cancelled uploads do not update receipt state',
    );
    assert.equal(finished.mock.calls[0].arguments[1], next.id);
    await worker.check();
    console.log(
      `verified real SDK abort, two unlocked retry jobs and next job completion in ${elapsed}ms`,
    );
  },
);

test(
  'SIGTERM이 Graphile을 통해 진행 중 업로드를 취소하고 재시도 가능한 상태로 정상 종료한다',
  { timeout: 20000 },
  async (t) => {
    const fixture = await setup(t);
    const queued = await fixture.queue(true);
    const source = `
    const { createBackend } = await import('./src/backend/domain/main.ts');
    const { RuntimeLifecycle } = await import('./src/backend/global/runtime/runtimeLifecycle.ts');
    const { app } = await createBackend(async app => {
      app.enableShutdownHooks(['SIGTERM'], { useProcessExit: true });
      await app.get(RuntimeLifecycle).prepare(app, { host: '127.0.0.1' });
    });
    await app.listen(0, '127.0.0.1');
    process.send('ready');
  `;
    const child = spawn(
      process.execPath,
      [
        '--import',
        '@swc-node/register/esm-register',
        '--input-type=module',
        '-e',
        source,
      ],
      { env: process.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );
    t.after(() => child.kill('SIGKILL'));
    let output = '';
    child.stdout!.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr!.on('data', (chunk) => {
      output += chunk;
    });
    const exited = once(child, 'exit');
    await once(child, 'message');
    await waitUntil(() => fixture.active.has(queued.id), 5000);
    const started = Date.now();
    child.kill('SIGTERM');
    assert.deepEqual(await exited, [0, null], output);
    assert.ok(Date.now() - started < 10000, output);
    assert.equal(
      fixture.cancelled.has(queued.id),
      true,
      'the real HTTP upload connection was closed',
    );
    const retry = (
      await fixture.db.query(
        'SELECT attempts,max_attempts,locked_by,last_error FROM graphile_worker._private_jobs WHERE id=$1',
        [queued.jobId],
      )
    ).rows[0];
    assert.equal(retry.attempts, 1);
    assert.equal(retry.max_attempts, 8);
    assert.equal(retry.locked_by, null);
    assert.match(retry.last_error, /interrupted during worker shutdown/);
  },
);
