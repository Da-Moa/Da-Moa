import { before } from 'node:test';
import { getPrismaClient } from '../support/domainTestSupport.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { makeWorkerUtils } from 'graphile-worker';
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { readAccessToken } from '../../global/auth/native.ts';
import { createDatabaseClient } from '../../global/database/db.ts';
import { uuidV7 } from '../../../shared/uuid.ts';
import { signInKakao } from '../support/domainTestSupport.ts';
import {
  acceptInvite,
  createGroup,
  createInvite,
} from '../support/domainTestSupport.ts';
import {
  addReceipt,
  createRound,
  getReceipt,
  getRound,
  removeReceipt,
  saveExpense,
} from '../support/domainTestSupport.ts';
import { completeTestOnboarding } from './bankTestSupport.ts';
import { applyMigrations } from '../../../../scripts/migrations.mjs';
import { drainReceiptQueue } from './receiptWorkerTestSupport';

const testUrl = process.env.TEST_DATABASE_URL;
if (
  !testUrl ||
  !['localhost', '127.0.0.1', '[::1]'].includes(new URL(testUrl).hostname) ||
  !new URL(testUrl).pathname.includes('test')
)
  throw new Error('An isolated local test database is required');
process.env.DATABASE_URL = testUrl;
process.env.AUTH_JWT_SECRET ||=
  'integration-only-not-a-production-secret-0123456789';
const key = () => randomUUID();
const code = (expected: string) => (error: unknown) =>
  (error as { code: string }).code === expected;
async function member() {
  const limited = await signInKakao(`receipt-queue:${key()}`, {
    displayName: '영수증 큐 검증',
    email: null,
    profileImageUrl: null,
  });
  return readAccessToken(
    (
      await completeTestOnboarding(readAccessToken(limited.accessToken), {
        bankName: '검증은행',
        accountNumber: '12340312345678',
        accountHolder: '영수증 큐 검증',
      })
    ).accessToken,
  )!;
}

test('receipt queue authorizes before reading and persists atomically after one admission query; a new worker resumes, retries and cleans deleted receipts', async (t) => {
  const db = createDatabaseClient(testUrl);
  await db.connect();
  const originalLog = process.env.DB_QUERY_LOG,
    originalSend = S3Client.prototype.send;
  let events: string[] = [],
    putKeys: string[] = [],
    deleteKeys: string[] = [],
    failPut = false;
  let holdPut: ((objectKey: string) => Promise<void>) | undefined;
  try {
    await applyMigrations(db);
    const owner = await member(),
      author = await member(),
      other = await member();
    const group = await createGroup(owner, uuidV7(), {
      name: '영수증 영속 큐 검증',
    });
    const invite = await createInvite(owner, key(), group.id, {});
    for (const actor of [author, other])
      await acceptInvite(actor, key(), invite.sharePath!.split('/').at(-1)!);
    const round = await createRound(owner, uuidV7(), group.id, {
      name: '영속 큐',
      participantIds: [owner.userId, author.userId, other.userId],
    });
    const expense = await saveExpense(author, key(), round.id, {
      currency: 'KRW',
      description: '영수증 큐 지출',
      amount: '10',
      payerId: author.userId,
      splitMode: 'ALL',
      expectedVersion: round.version,
    });
    const bytes = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#369' },
    })
      .avif()
      .toBuffer();
    let version = expense.version!,
      published = 0;
    process.env.DB_QUERY_LOG = 'true';
    t.mock.method(console, 'info', (message: string) => {
      events.push(
        /FROM "public"\."users" WHERE/.test(message.replace(/\s+/g, ' '))
          ? 'AUTH'
          : 'SQL',
      );
    });
    t.mock.method(
      S3Client.prototype,
      'send',
      async function (
        this: S3Client,
        command: PutObjectCommand | DeleteObjectCommand,
      ) {
        if (command instanceof PutObjectCommand) {
          putKeys.push(command.input.Key!);
          assert.deepEqual(command.input.Body, bytes);
          await holdPut?.(command.input.Key!);
          if (failPut) throw new Error('test unavailable MinIO');
        }
        if (command instanceof DeleteObjectCommand)
          deleteKeys.push(command.input.Key!);
        return Reflect.apply(originalSend, this, [command]);
      },
    );
    const upload =
      (v = version, name = 'receipt.avif', type = 'image/avif') =>
      async () => {
        events.push('READ');
        return { expectedVersion: v, bytes, name, type };
      };
    events = [];
    await assert.rejects(
      addReceipt(null, '', round.id, expense.id, upload()),
      code('unauthorized'),
    );
    assert.deepEqual(events, []);
    await assert.rejects(
      addReceipt(
        { ...owner, userId: key() },
        '',
        round.id,
        expense.id,
        upload(),
      ),
      code('unauthorized'),
    );
    assert.deepEqual(events, ['AUTH']);
    for (const [name, type] of [
      ['receipt.png', 'image/avif'],
      ['receipt.avif', 'image/png'],
    ]) {
      events = [];
      await assert.rejects(
        addReceipt(
          author,
          key(),
          round.id,
          expense.id,
          upload(version, name, type),
        ),
        code('unsupported_receipt_type'),
      );
      assert.deepEqual(events, ['AUTH', 'SQL', 'READ']);
    }
    events = [];
    await assert.rejects(
      addReceipt(other, key(), round.id, expense.id, upload()),
      code('forbidden'),
    );
    assert.deepEqual(events, ['AUTH', 'SQL']);
    assert.equal(putKeys.length, 0);
    const ticket = key(),
      requestVersion = version;
    events = [];
    failPut = true;
    const queued = await addReceipt(
      author,
      ticket,
      round.id,
      expense.id,
      upload(),
      () => {
        published++;
      },
    );
    assert.deepEqual(events, ['AUTH', 'SQL', 'READ', 'SQL']);
    assert.equal(published, 1);
    assert.equal(putKeys.length, 0);
    version = queued.version!;
    const pending = (
      await db.query(
        'SELECT storage_status,object_key FROM expense_receipts WHERE id=$1',
        [queued.id],
      )
    ).rows[0];
    assert.deepEqual(pending, { storage_status: 'PENDING', object_key: null });
    const jobs = await db.query(
      'SELECT id,payload FROM graphile_worker._private_jobs WHERE key=$1',
      [`receipt:${queued.id}`],
    );
    assert.equal(jobs.rowCount, 1);
    assert.equal(jobs.rows[0].payload.content, bytes.toString('base64'));
    assert.equal(
      (await getRound(author, round.id, new URLSearchParams())).expenses[0]
        .receipts[0].storageStatus,
      'PENDING',
    );
    await assert.rejects(getReceipt(owner, queued.id), code('receipt_pending'));
    events = [];
    assert.deepEqual(
      await addReceipt(
        author,
        ticket,
        round.id,
        expense.id,
        upload(requestVersion),
        () => {
          published++;
        },
      ),
      queued,
    );
    assert.deepEqual(events, ['AUTH', 'SQL', 'READ', 'SQL']);
    assert.equal(published, 1);
    assert.equal(putKeys.length, 0);
    await drainReceiptQueue();
    assert.equal(
      (
        await db.query(
          'SELECT storage_status FROM expense_receipts WHERE id=$1',
          [queued.id],
        )
      ).rows[0].storage_status,
      'PENDING',
    );
    const retry = (
      await db.query(
        'SELECT attempts,last_error FROM graphile_worker.jobs WHERE id=$1',
        [jobs.rows[0].id],
      )
    ).rows[0];
    assert.equal(retry.attempts, 1);
    assert.ok(retry.last_error);
    failPut = false;
    const utils = await makeWorkerUtils({ connectionString: testUrl });
    try {
      await utils.rescheduleJobs([String(jobs.rows[0].id)], {
        runAt: new Date(),
      });
    } finally {
      await utils.release();
    }
    // A fresh process has no access to the original request buffer or worker memory.
    let workerOutput = '';
    const worker = spawn(
      process.execPath,
      [
        '--import',
        '@swc-node/register/esm-register',
        '--input-type=module',
        '-e',
        "const m=await import('./src/backend/test/integration/receiptWorkerTestSupport.ts');await m.drainReceiptQueue()",
      ],
      { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    worker.stdout.on('data', (b) => {
      workerOutput += b;
    });
    worker.stderr.on('data', (b) => {
      workerOutput += b;
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      worker.once('error', reject);
      worker.once('exit', resolve);
    });
    assert.equal(exitCode, 0, workerOutput);
    const sql = workerOutput
      .split('SQL:')
      .slice(1)
      .map((value) => value.trim());
    assert.equal(
      sql.length,
      1,
      'Prisma starts without schema/version probes and saves receipt storage with one statement',
    );
    assert.deepEqual(
      Buffer.from((await getReceipt(owner, queued.id)).content),
      bytes,
    );
    assert.equal(
      (
        await db.query('SELECT id FROM graphile_worker.jobs WHERE key=$1', [
          `receipt:${queued.id}`,
        ])
      ).rowCount,
      0,
    );
    const cancelled = await addReceipt(
      author,
      key(),
      round.id,
      expense.id,
      upload(),
    );
    version = cancelled.version!;
    const removed = await removeReceipt(
      author,
      key(),
      round.id,
      expense.id,
      cancelled.id,
      { expectedVersion: version },
    );
    version = removed.version!;
    await drainReceiptQueue();
    assert.equal(
      (
        await db.query('SELECT id FROM graphile_worker.jobs WHERE key=$1', [
          `receipt:${cancelled.id}`,
        ])
      ).rowCount,
      0,
    );
    assert.ok(
      !putKeys.includes(`receipts/${author.userId}/${cancelled.id}.avif`),
    );
    await assert.rejects(getReceipt(owner, cancelled.id), code('not_found'));
    const inflight = await addReceipt(
      author,
      key(),
      round.id,
      expense.id,
      upload(),
    );
    version = inflight.version!;
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    holdPut = async () => {
      enter();
      await gate;
    };
    const processing = drainReceiptQueue();
    try {
      await entered;
      version = (
        await removeReceipt(author, key(), round.id, expense.id, inflight.id, {
          expectedVersion: version,
        })
      ).version!;
    } finally {
      release();
      await processing;
      holdPut = undefined;
    }
    assert.ok(
      deleteKeys.includes(`receipts/${author.userId}/${inflight.id}.avif`),
    );
    await assert.rejects(getReceipt(owner, inflight.id), code('not_found'));
    const failed = await addReceipt(
      author,
      key(),
      round.id,
      expense.id,
      upload(),
    );
    version = failed.version!;
    const failedJob = (
      await db.query('SELECT id FROM graphile_worker.jobs WHERE key=$1', [
        `receipt:${failed.id}`,
      ])
    ).rows[0];
    const failureUtils = await makeWorkerUtils({ connectionString: testUrl });
    try {
      await failureUtils.rescheduleJobs([String(failedJob.id)], {
        maxAttempts: 1,
      });
    } finally {
      await failureUtils.release();
    }
    failPut = true;
    await drainReceiptQueue();
    failPut = false;
    assert.equal(
      (
        await db.query(
          'SELECT storage_status FROM expense_receipts WHERE id=$1',
          [failed.id],
        )
      ).rows[0].storage_status,
      'FAILED',
    );
    await assert.rejects(
      getReceipt(owner, failed.id),
      code('storage_unavailable'),
    );
    version = (
      await removeReceipt(author, key(), round.id, expense.id, failed.id, {
        expectedVersion: version,
      })
    ).version!;
    assert.equal(
      (
        await db.query('SELECT id FROM graphile_worker.jobs WHERE id=$1', [
          failedJob.id,
        ])
      ).rowCount,
      0,
    );
    await db.query(`CREATE FUNCTION reject_receipt_queue() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test queue rollback'; END $$;
      CREATE TRIGGER reject_receipt_queue BEFORE INSERT ON expense_receipts FOR EACH ROW EXECUTE FUNCTION reject_receipt_queue()`);
    try {
      await assert.rejects(
        addReceipt(author, key(), round.id, expense.id, upload()),
        code('P0001'),
      );
      assert.equal(
        (await getRound(owner, round.id, new URLSearchParams())).version,
        version,
      );
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE task_identifier='store_receipt'",
          )
        ).rows[0].n,
        0,
      );
    } finally {
      await db.query(
        'DROP TRIGGER reject_receipt_queue ON expense_receipts; DROP FUNCTION reject_receipt_queue()',
      );
    }
  } finally {
    if (originalLog === undefined) delete process.env.DB_QUERY_LOG;
    else process.env.DB_QUERY_LOG = originalLog;
    t.mock.restoreAll();
    await db.end();
  }
});

before(async () => {
  await getPrismaClient(process.env.TEST_DATABASE_URL!);
});
