import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { makeWorkerUtils, runOnce } from 'graphile-worker';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createAccessToken } from '../support/legacyTokenTestSupport.ts';
const WebSocket = createRequire(import.meta.url)('ws');
import sharp from 'sharp';
import { createBackend } from '../../domain/main';
import { AuthService } from '../../global/auth/service/auth.service';
import { GroupService } from '../../domain/group/service/group.service';
import { RealtimeAuthorizationService } from '../../global/auth/service/realtimeAuthorization.service';
import { PrismaService } from '../../global/database/prisma.service';
import { createDatabaseClient } from '../../global/database/db';
import { RuntimeLifecycle } from '../../global/runtime/runtimeLifecycle';
import { MetricsServer } from '../../global/monitoring/metricsServer';
import { RealtimePublisher } from '../../global/util/invalidationUtil';
import { ReceiptStorage } from '../../global/util/minio.util';
import { ReceiptWorker } from '../../domain/settle/service/receiptWorker';
import { SettleRepository } from '../../domain/settle/repository/settle.repository';
import { uuidV7 } from '../../../shared/uuid';
import { applyMigrations } from '../../../../scripts/migrations.mjs';

const testUrl = process.env.TEST_DATABASE_URL;
if (
  !testUrl ||
  !['localhost', '127.0.0.1', '[::1]'].includes(new URL(testUrl).hostname) ||
  !new URL(testUrl).pathname.includes('test')
)
  throw new Error('An isolated local test database is required');
process.env.DATABASE_URL = testUrl;

async function runtime() {
  const { app } = await createBackend(async (backend) => {
    await backend.get(RuntimeLifecycle).prepare(backend, {
      host: '127.0.0.1',
      metricsPort: 0,
      startWorker: false,
    });
  });
  await app.listen(0, '127.0.0.1');
  return app;
}

test('Nest 앱을 두 번 닫아도 해당 앱의 DB·WebSocket·메트릭 연결만 닫는다', async (t) => {
  const first = await runtime();
  const second = await runtime();
  let resume = () => {};
  t.after(async () => {
    resume();
    await first.close();
    await second.close();
  });
  const prismaA = first.get(PrismaService),
    prismaB = second.get(PrismaService);
  const poolA = prismaA.poolFor(testUrl),
    poolB = prismaB.poolFor(testUrl);
  assert.notEqual(poolA, poolB);
  const pidA = (
    await prismaA.client.$queryRawUnsafe<{ pid: number }[]>(
      'SELECT pg_backend_pid() AS pid',
    )
  )[0].pid;
  const pidB = (
    await prismaB.client.$queryRawUnsafe<{ pid: number }[]>(
      'SELECT pg_backend_pid() AS pid',
    )
  )[0].pid;
  assert.notEqual(pidA, pidB);
  const sockets: InstanceType<typeof WebSocket>[] = [];
  for (const app of [first, second]) {
    t.mock.method(
      app.get(RealtimeAuthorizationService),
      'authenticate',
      async () => ({ status: 200, id: randomUUID() }),
    );
    const origin = await app.getUrl();
    const socket = new WebSocket(
      `${origin.replace(/^http/, 'ws')}/realtime`,
      ['da-moa', createAccessToken(randomUUID(), 'shutdown-test')],
      { headers: { origin } },
    );
    sockets.push(socket);
    await once(socket, 'open');
  }
  t.after(() => sockets.forEach((socket) => socket.terminate()));
  const metricA = first.get(MetricsServer).getUrl(),
    metricB = second.get(MetricsServer).getUrl();
  const socketClosed = once(sockets[0], 'close');
  const preconnect = connect(
    Number(new URL(await first.getUrl()).port),
    '127.0.0.1',
  );
  await once(preconnect, 'connect');
  t.after(() => preconnect.destroy());
  const preconnectClosed = once(preconnect, 'close');
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  t.mock.method(first.get(GroupService), 'listGroups', async () => {
    enter();
    await gate;
    await prismaA.client.$queryRawUnsafe('SELECT 1');
    return { items: [], nextCursor: null };
  });
  const response = fetch(`${await first.getUrl()}/api/groups`, {
    headers: {
      authorization: `Bearer ${createAccessToken(randomUUID(), 'shutdown-http')}`,
    },
  });
  await entered;
  let closed = false;
  const closing = Promise.all([first.close(), first.close()]).then(() => {
    closed = true;
  });
  await delay(50);
  assert.equal(
    closed,
    false,
    'active HTTP work finishes before the database closes',
  );
  assert.equal(poolA.ended, false);
  resume();
  assert.equal((await response).status, 200);
  await closing;
  await socketClosed;
  await preconnectClosed;
  assert.equal(poolA.ended, true);
  assert.equal(first.getHttpServer().listening, false);
  assert.equal(first.getHttpServer().listenerCount('upgrade'), 0);
  assert.equal(first.get(RealtimePublisher).realtimeEnabled(), false);
  assert.throws(() => prismaA.client, /closed/);
  await assert.rejects(fetch(`${metricA}/metrics`));
  assert.equal((await fetch(`${metricB}/metrics`)).status, 200);
  assert.equal(sockets[1].readyState, WebSocket.OPEN);
  assert.equal(
    (
      await prismaB.client.$queryRawUnsafe<{ value: number }[]>(
        'SELECT 1 AS value',
      )
    )[0].value,
    1,
  );
  assert.equal(
    (
      await prismaB.client.$queryRawUnsafe<{ count: bigint }[]>(
        'SELECT count(*) AS count FROM pg_stat_activity WHERE pid=$1',
        pidA,
      )
    )[0].count,
    0n,
  );
  await second.close();
  assert.equal(poolB.ended, true);
  assert.equal(second.getHttpServer().listenerCount('upgrade'), 0);
});

test(
  '앱 종료가 영수증 작업을 마친 뒤 Prisma 연결을 닫는다',
  { timeout: 20000 },
  async (t) => {
    const db = createDatabaseClient(testUrl);
    await db.connect();
    t.after(() => db.end());
    await applyMigrations(db);
    const app = await runtime();
    let release!: () => void, enter!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    t.after(async () => {
      release();
      await app.close();
    });
    const origin = await app.getUrl();
    const signup = await app
      .get(AuthService)
      .signInKakao(`shutdown:${randomUUID()}`, {
        displayName: '종료 검증',
        email: null,
        profileImageUrl: null,
      });
    let token = signup.accessToken;
    const request = async (path: string, body: unknown) => {
      const multipart = body instanceof FormData;
      const response = await fetch(`${origin}/api/${path}`, {
        method: 'POST',
        headers: {
          origin,
          authorization: `Bearer ${token}`,
          'Idempotency-Key': uuidV7(),
          ...(multipart ? {} : { 'content-type': 'application/json' }),
        },
        body: multipart ? (body as FormData) : JSON.stringify(body),
      });
      assert.equal(
        response.status,
        path.endsWith('/receipts') ? 202 : 200,
        await response.clone().text(),
      );
      return (await response.json()).data;
    };
    token = (
      await request('me/onboarding', {
        bankCode: '004',
        accountNumber: '12340312345678',
        accountHolder: '종료 검증',
        expectedBankVersion: 0,
        confirmRejoin: false,
      })
    ).accessToken;
    const ownerToken = token;
    const group = await request('groups', { name: '종료 검증' });
    const invite = await request(`groups/${group.id}/invites`, {});
    const member = await app
      .get(AuthService)
      .signInKakao(`shutdown-member:${randomUUID()}`, {
        displayName: '동료',
        email: null,
        profileImageUrl: null,
      });
    token = member.accessToken;
    token = (
      await request('me/onboarding', {
        bankCode: '004',
        accountNumber: '12340312345678',
        accountHolder: '동료',
        expectedBankVersion: 0,
        confirmRejoin: false,
      })
    ).accessToken;
    await request(
      `invites/${invite.sharePath.split('/').at(-1)}/accept`,
      undefined,
    );
    token = ownerToken;
    const round = await request(`groups/${group.id}/rounds`, {
      name: '종료 검증',
      participantIds: [signup.userId, member.userId],
    });
    const expense = await request(`rounds/${round.id}/expenses`, {
      currency: 'KRW',
      description: '종료 검증',
      amount: '10',
      payerId: signup.userId,
      splitMode: 'ALL',
      expectedVersion: round.version,
    });
    const bytes = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#369' },
    })
      .avif()
      .toBuffer();
    const form = new FormData();
    form.set('expectedVersion', String(expense.version));
    form.set(
      'file',
      new Blob([new Uint8Array(bytes)], { type: 'image/avif' }),
      'receipt.avif',
    );
    const queued = await request(
      `rounds/${round.id}/expenses/${expense.id}/receipts`,
      form,
    );
    const storage = app.get(ReceiptStorage),
      put = storage.putReceipt.bind(storage);
    t.mock.method(
      storage,
      'putReceipt',
      async (...args: Parameters<ReceiptStorage['putReceipt']>) => {
        enter();
        await gate;
        return put(...args);
      },
    );
    const worker = app.get(ReceiptWorker);
    await worker.start();
    await entered;
    const prisma = app.get(PrismaService),
      pool = prisma.poolFor(testUrl);
    let closed = false;
    const closing = app.close().then(() => {
      closed = true;
    });
    await delay(100);
    assert.equal(closed, false, 'shutdown waits for the active SDK upload');
    assert.equal(
      pool.ended,
      false,
      'the worker still owns access to an open database',
    );
    assert.equal(
      (
        await prisma.client.$queryRawUnsafe<{ value: number }[]>(
          'SELECT 1 AS value',
        )
      )[0].value,
      1,
    );
    release();
    await closing;
    assert.equal(pool.ended, true);
    assert.equal(
      (
        await db.query(
          'SELECT storage_status FROM expense_receipts WHERE id=$1',
          [queued.id],
        )
      ).rows[0].storage_status,
      'READY',
    );
    assert.equal(
      (
        await db.query('SELECT id FROM graphile_worker.jobs WHERE key=$1', [
          `receipt:${queued.id}`,
        ])
      ).rowCount,
      0,
    );
    await assert.rejects(worker.check(), /not running/);
    await storage.deleteReceiptObject(
      `receipts/${signup.userId}/${queued.id}.avif`,
    );
  },
);

test('시작 중 메트릭 포트 열기 실패 시 준비한 전송 계층과 해당 앱의 풀을 닫는다', async (t) => {
  const occupied = createServer();
  occupied.listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  t.after(
    () => new Promise<void>((resolve) => occupied.close(() => resolve())),
  );
  const address = occupied.address();
  assert.ok(address && typeof address !== 'string');
  let prisma!: PrismaService, server: any, publisher!: RealtimePublisher;
  await assert.rejects(
    createBackend(async (app) => {
      prisma = app.get(PrismaService);
      server = app.getHttpServer();
      publisher = app.get(RealtimePublisher);
      await app.get(RuntimeLifecycle).prepare(app, {
        host: '127.0.0.1',
        metricsPort: address.port,
        startWorker: false,
      });
    }),
    (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE',
  );
  assert.equal(server.listenerCount('upgrade'), 0);
  assert.equal(publisher.realtimeEnabled(), false);
  assert.throws(() => prisma.client, /closed/);
});

async function childRuntime(blockUpload: boolean) {
  const source = `
    const { createBackend } = await import('./src/backend/domain/main.ts');
    const { RuntimeLifecycle } = await import('./src/backend/global/runtime/runtimeLifecycle.ts');
    const { MetricsServer } = await import('./src/backend/global/monitoring/metricsServer.ts');
    const { ReceiptWorker } = await import('./src/backend/domain/settle/service/receiptWorker.ts');
    const { ReceiptStorage } = await import('./src/backend/global/util/minio.util.ts');
    const { PrismaService } = await import('./src/backend/global/database/prisma.service.ts');
    const { app } = await createBackend(async app => {
      app.enableShutdownHooks(['SIGTERM'], { useProcessExit: true });
      await app.get(RuntimeLifecycle).prepare(app, { host: '127.0.0.1', metricsPort: 0, startWorker: false });
      if (${blockUpload}) app.get(ReceiptStorage).putReceipt = async () => {
        process.send({ type: 'job' }); await new Promise(() => {});
      };
    });
    await app.listen(0, '127.0.0.1');
    const [{ pid }] = await app.get(PrismaService).client.$queryRawUnsafe('SELECT pg_backend_pid() AS pid');
    process.send({ type: 'ready', origin: await app.getUrl(), metrics: app.get(MetricsServer).getUrl(), pid });
    if (${blockUpload}) await app.get(ReceiptWorker).start();
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
    {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  let output = '';
  child.stdout!.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr!.on('data', (chunk) => {
    output += chunk;
  });
  const messages: any[] = [];
  child.on('message', (message) => messages.push(message));
  const exited = once(child, 'exit');
  const message = async (type: string) => {
    while (!messages.some((value) => value.type === type)) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(output);
      await delay(10);
    }
    return messages.find((value) => value.type === type);
  };
  return { child, exited, message, output: () => output };
}

test(
  'SIGTERM이 Nest 종료 훅으로 HTTP·메트릭·DB 연결을 닫고 정상 종료한다',
  { timeout: 15000 },
  async (t) => {
    const runtime = await childRuntime(false);
    t.after(() => runtime.child.kill('SIGKILL'));
    const ready = await runtime.message('ready');
    assert.equal(
      (await fetch(`${ready.origin}/api/health/database`)).status,
      200,
    );
    runtime.child.kill('SIGTERM');
    assert.deepEqual(await runtime.exited, [0, null], runtime.output());
    await assert.rejects(fetch(`${ready.origin}/api/health/database`));
    await assert.rejects(fetch(`${ready.metrics}/metrics`));
    const db = createDatabaseClient(testUrl);
    await db.connect();
    try {
      assert.equal(
        (
          await db.query(
            'SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid=$1',
            [ready.pid],
          )
        ).rows[0].count,
        0,
      );
    } finally {
      await db.end();
    }
  },
);

test(
  '워커 종료 제한 시간을 넘기면 미완료 작업을 Graphile 복구 대상으로 남긴다',
  { timeout: 25000 },
  async (t) => {
    const db = createDatabaseClient(testUrl);
    await db.connect();
    t.after(() => db.end());
    await applyMigrations(db);
    const utils = await makeWorkerUtils({ connectionString: testUrl });
    t.after(() => utils.release());
    const id = randomUUID(),
      userId = randomUUID();
    const job = await utils.addJob(
      'store_receipt',
      { id, userId, content: Buffer.from('deadline-test').toString('base64') },
      { jobKey: `shutdown:${id}`, maxAttempts: 8 },
    );
    const runtime = await childRuntime(true);
    t.after(() => runtime.child.kill('SIGKILL'));
    await runtime.message('ready');
    await runtime.message('job');
    runtime.child.kill('SIGTERM');
    assert.deepEqual(await runtime.exited, [1, null], runtime.output());
    assert.match(runtime.output(), /Application shutdown timed out/);
    const pending = (
      await db.query(
        'SELECT attempts,max_attempts,locked_by FROM graphile_worker._private_jobs WHERE id=$1',
        [job.id],
      )
    ).rows[0];
    assert.ok(pending && pending.attempts < pending.max_attempts);
    // A hard exit retains the library lock until expiry. Explicit recovery is safe only after confirming that worker has exited.
    await utils.forceUnlockWorkers([pending.locked_by]);
    await utils.rescheduleJobs([String(job.id)], { runAt: new Date() });
    const app = await runtimeAppForRecovery();
    t.after(() => app.close());
    const repository = t.mock.method(
      app.get(SettleRepository),
      'finishReceiptStorage',
    );
    await runOnce({
      connectionString: testUrl,
      noHandleSignals: true,
      taskList: app.get(ReceiptWorker).tasks,
      preset: app.get(ReceiptWorker).preset,
    });
    assert.equal(repository.mock.callCount(), 1);
    assert.equal(
      (
        await db.query('SELECT id FROM graphile_worker.jobs WHERE id=$1', [
          job.id,
        ])
      ).rowCount,
      0,
    );
  },
);

async function runtimeAppForRecovery() {
  return (await createBackend()).app;
}
