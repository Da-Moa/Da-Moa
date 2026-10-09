import { before } from 'node:test';
import { getPrismaClient } from '../support/domainTestSupport.ts';
import { addStoredReceipt as addReceipt } from '../support/receiptWorkerTestSupport';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { readAccessToken } from '../support/legacyTokenTestSupport.ts';
import { createDatabaseClient } from '../../global/database/db.ts';
import { getDatabasePool } from '../support/domainTestSupport.ts';
import { uuidV7 } from '../../../shared/uuid.ts';
import { signInKakao } from '../support/domainTestSupport.ts';
import {
  acceptInvite,
  createGroup,
  createInvite,
} from '../support/domainTestSupport.ts';
import {
  createRound,
  getReceipt,
  removeReceipt,
  saveExpense,
} from '../support/domainTestSupport.ts';
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
  'integration-only-not-a-production-secret-0123456789';
const key = () => randomUUID();
const code = (expected: string) => (error: unknown) =>
  (error as { code: string }).code === expected;

test('receipt deletion uses AUTH, authorized context and one atomic deletion with no extra audience SQL', async (t) => {
  const db = createDatabaseClient(testUrl);
  await db.connect();
  const queryLog = process.env.DB_QUERY_LOG;
  const originalSend = S3Client.prototype.send;
  let events: string[] = [],
    statements: string[] = [],
    deletedKeys: string[] = [],
    failDelete = false;
  let published = 0,
    concurrent = false;
  try {
    await applyMigrations(db);
    const member = async () => {
      const signup = await signInKakao(`receipt-delete:${key()}`, {
        displayName: '영수증 삭제 검증',
        email: null,
        profileImageUrl: null,
      });
      return readAccessToken(
        (
          await completeTestOnboarding(readAccessToken(signup.accessToken), {
            bankName: '검증은행',
            accountHolder: '영수증 삭제 검증',
            accountNumber: '12340312345678',
          })
        ).accessToken,
      )!;
    };
    const groupOwner = await member(),
      owner = await member(),
      author = await member(),
      outsider = await member();
    const group = await createGroup(groupOwner, uuidV7(), {
      name: '영수증 삭제 검증',
    });
    const invite = await createInvite(groupOwner, key(), group.id, {});
    for (const actor of [owner, author])
      await acceptInvite(actor, key(), invite.sharePath!.split('/').at(-1)!);
    const bytes = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#fff' },
    })
      .avif()
      .toBuffer();
    const fixture = async () => {
      const round = await createRound(owner, uuidV7(), group.id, {
        name: '삭제 검증 회차',
        participantIds: [owner.userId, author.userId, groupOwner.userId],
      });
      const expense = await saveExpense(author, key(), round.id, {
        currency: 'KRW',
        description: '삭제 검증 지출',
        amount: '10',
        payerId: author.userId,
        splitMode: 'ALL',
        expectedVersion: round.version,
      });
      const receipt = await addReceipt(
        author,
        key(),
        round.id,
        expense.id,
        expense.version!,
        bytes,
        'image/avif',
      );
      const objectKey = (
        await db.query('SELECT object_key FROM expense_receipts WHERE id=$1', [
          receipt.id,
        ])
      ).rows[0].object_key;
      return { round, expense, receipt, objectKey };
    };
    const f = await fixture();
    process.env.DB_QUERY_LOG = 'true';
    t.mock.method(console, 'info', (message: string) => {
      const sql = message
        .replace(/^SQL:\s*/, '')
        .replace(/\s+/g, ' ')
        .trim();
      statements.push(sql);
      events.push(/FROM "public"\."users" WHERE/.test(sql) ? 'AUTH' : 'SQL');
    });
    t.mock.method(console, 'error', () => {});
    t.mock.method(
      S3Client.prototype,
      'send',
      async function (this: S3Client, command: DeleteObjectCommand) {
        if (command instanceof DeleteObjectCommand) {
          const pool = await getDatabasePool(testUrl);
          if (!concurrent)
            assert.equal(
              pool.idleCount,
              pool.totalCount,
              'release the DB connection before MinIO cleanup',
            );
          events.push('DELETE');
          deletedKeys.push(command.input.Key!);
          if (failDelete) throw new Error('test cleanup failure');
        }
        return Reflect.apply(originalSend, this, [command]);
      },
    );
    const audience = (value: { groupId: string; userIds: string[] }) => {
      published++;
      events.push('PUBLISH');
      assert.equal(value.groupId, group.id);
      assert.deepEqual(
        value.userIds,
        [owner.userId, author.userId, groupOwner.userId].sort(),
      );
    };
    const trace = async <T>(expected: string[], work: () => Promise<T>) => {
      events = [];
      statements = [];
      deletedKeys = [];
      const result = await work();
      assert.deepEqual(events, expected);
      assert.ok(
        statements.every(
          (sql) =>
            !/^(BEGIN|COMMIT|ROLLBACK|SET)\b|pg_advisory|FOR UPDATE|FOR SHARE/.test(
              sql,
            ),
        ),
      );
      if (statements.length > 1)
        assert.match(
          statements[1],
          /LEFT JOIN expenses.*LEFT JOIN expense_receipts.*operation = 'receipt.delete'/,
        );
      if (statements.length > 2)
        assert.match(
          statements[2],
          /UPDATE rounds.*DELETE FROM expense_receipts.*INSERT INTO mutation_requests/,
        );
      return result;
    };
    const body = { expectedVersion: f.receipt.version! };
    for (const [
      actor,
      roundId,
      expenseId,
      receiptId,
      ticket,
      input,
      error,
      expected,
    ] of [
      [
        null,
        f.round.id,
        f.expense.id,
        f.receipt.id,
        '',
        body,
        'unauthorized',
        [],
      ],
      [
        { ...owner, userId: key() },
        f.round.id,
        f.expense.id,
        f.receipt.id,
        key(),
        body,
        'unauthorized',
        ['AUTH'],
      ],
      [
        owner,
        f.round.id,
        f.expense.id,
        f.receipt.id,
        key(),
        { unexpected: true },
        'invalid_input',
        [],
      ],
      [
        owner,
        f.round.id,
        f.expense.id,
        f.receipt.id,
        '',
        body,
        'invalid_request_key',
        [],
      ],
      [
        groupOwner,
        f.round.id,
        f.expense.id,
        f.receipt.id,
        key(),
        body,
        'forbidden',
        ['AUTH', 'SQL'],
      ],
      [
        outsider,
        f.round.id,
        f.expense.id,
        f.receipt.id,
        key(),
        body,
        'not_found',
        ['AUTH', 'SQL'],
      ],
      [
        owner,
        key(),
        f.expense.id,
        f.receipt.id,
        key(),
        body,
        'not_found',
        ['AUTH', 'SQL'],
      ],
      [
        owner,
        f.round.id,
        key(),
        f.receipt.id,
        key(),
        body,
        'not_found',
        ['AUTH', 'SQL'],
      ],
      [
        owner,
        f.round.id,
        f.expense.id,
        key(),
        key(),
        body,
        'not_found',
        ['AUTH', 'SQL'],
      ],
      [
        owner,
        f.round.id,
        f.expense.id,
        f.receipt.id,
        key(),
        { expectedVersion: '1' },
        'invalid_version',
        [],
      ],
      [
        owner,
        f.round.id,
        f.expense.id,
        f.receipt.id,
        key(),
        { expectedVersion: body.expectedVersion - 1 },
        'stale_round',
        ['AUTH', 'SQL'],
      ],
    ] as const)
      await trace([...expected], () =>
        assert.rejects(
          removeReceipt(
            actor,
            ticket,
            roundId,
            expenseId,
            receiptId,
            input,
            audience,
          ),
          code(error),
        ),
      );
    await db.query(
      'UPDATE round_members SET excluded_at=1 WHERE round_id=$1 AND user_id=$2',
      [f.round.id, author.userId],
    );
    await trace(['AUTH', 'SQL'], () =>
      assert.rejects(
        removeReceipt(
          author,
          key(),
          f.round.id,
          f.expense.id,
          f.receipt.id,
          body,
          audience,
        ),
        code('forbidden'),
      ),
    );
    await db.query(
      'UPDATE round_members SET excluded_at=NULL WHERE round_id=$1 AND user_id=$2',
      [f.round.id, author.userId],
    );
    const ticket = key();
    const saved = await trace(['AUTH', 'SQL', 'SQL', 'DELETE', 'PUBLISH'], () =>
      removeReceipt(
        author,
        ticket,
        f.round.id,
        f.expense.id,
        f.receipt.id,
        body,
        audience,
      ),
    );
    assert.equal(saved.version, body.expectedVersion + 1);
    assert.deepEqual(deletedKeys, [f.objectKey]);
    assert.equal(
      (await db.query('SELECT id FROM expenses WHERE id=$1', [f.expense.id]))
        .rowCount,
      1,
    );
    assert.equal(
      (
        await db.query('SELECT id FROM expense_receipts WHERE id=$1', [
          f.receipt.id,
        ])
      ).rowCount,
      0,
    );
    await assert.rejects(getReceipt(owner, f.receipt.id), code('not_found'));
    assert.deepEqual(
      await trace(['AUTH', 'SQL'], () =>
        removeReceipt(
          author,
          ticket,
          f.round.id,
          f.expense.id,
          f.receipt.id,
          body,
          audience,
        ),
      ),
      saved,
    );
    await trace(['AUTH', 'SQL'], () =>
      assert.rejects(
        removeReceipt(
          author,
          ticket,
          f.round.id,
          f.expense.id,
          f.receipt.id,
          { expectedVersion: saved.version! },
          audience,
        ),
        code('idempotency_conflict'),
      ),
    );
    await trace(['AUTH', 'SQL'], () =>
      assert.rejects(
        removeReceipt(
          author,
          key(),
          f.round.id,
          f.expense.id,
          f.receipt.id,
          { expectedVersion: saved.version! },
          audience,
        ),
        code('not_found'),
      ),
    );
    assert.equal(published, 1);

    await t.test(
      'failed success recording rolls back deletion and version; cleanup failure preserves DB success',
      async () => {
        const f = await fixture(),
          ticket = key(),
          body = { expectedVersion: f.receipt.version! };
        await db.query(`CREATE FUNCTION reject_receipt_deletion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.operation='receipt.delete' THEN RAISE EXCEPTION 'test receipt delete failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_receipt_deletion BEFORE INSERT ON mutation_requests FOR EACH ROW EXECUTE FUNCTION reject_receipt_deletion()`);
        try {
          await trace(['AUTH', 'SQL', 'SQL'], () =>
            assert.rejects(
              removeReceipt(
                owner,
                ticket,
                f.round.id,
                f.expense.id,
                f.receipt.id,
                body,
                audience,
              ),
              code('P0001'),
            ),
          );
          assert.equal(
            (
              await db.query('SELECT version FROM rounds WHERE id=$1', [
                f.round.id,
              ])
            ).rows[0].version,
            body.expectedVersion,
          );
          assert.equal(
            (
              await db.query('SELECT id FROM expense_receipts WHERE id=$1', [
                f.receipt.id,
              ])
            ).rowCount,
            1,
          );
          assert.equal(
            (
              await db.query(
                'SELECT 1 FROM mutation_requests WHERE request_key=$1',
                [ticket],
              )
            ).rowCount,
            0,
          );
        } finally {
          await db.query(
            'DROP TRIGGER reject_receipt_deletion ON mutation_requests; DROP FUNCTION reject_receipt_deletion()',
          );
        }
        failDelete = true;
        try {
          const result = await trace(
            ['AUTH', 'SQL', 'SQL', 'DELETE', 'PUBLISH'],
            () =>
              removeReceipt(
                owner,
                ticket,
                f.round.id,
                f.expense.id,
                f.receipt.id,
                body,
                audience,
              ),
          );
          assert.equal(
            (
              await db.query('SELECT id FROM expense_receipts WHERE id=$1', [
                f.receipt.id,
              ])
            ).rowCount,
            0,
          );
          assert.deepEqual(
            await trace(['AUTH', 'SQL'], () =>
              removeReceipt(
                owner,
                ticket,
                f.round.id,
                f.expense.id,
                f.receipt.id,
                body,
                audience,
              ),
            ),
            result,
          );
        } finally {
          failDelete = false;
        }
        await Reflect.apply(
          originalSend,
          new S3Client({
            endpoint: process.env.MINIO_ENDPOINT,
            region: 'us-east-1',
            forcePathStyle: true,
            credentials: {
              accessKeyId: process.env.MINIO_ACCESS_KEY!,
              secretAccessKey: process.env.MINIO_SECRET_KEY!,
            },
          }),
          [
            new DeleteObjectCommand({
              Bucket: process.env.MINIO_BUCKET,
              Key: f.objectKey,
            }),
          ],
        );
      },
    );

    await t.test(
      'waiting duplicate deletes replay once; confirmation wins before waiting deletion',
      async () => {
        const gate = createDatabaseClient(testUrl);
        await gate.connect();
        const waitForDeletes = async (count: number) => {
          const deadline = Date.now() + 10000;
          while (Date.now() < deadline) {
            await gate.query('SELECT pg_stat_clear_snapshot()');
            const waiting =
              await gate.query(`SELECT count(DISTINCT a.pid)::int AS count FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
            WHERE a.datname=current_database() AND NOT l.granted AND a.query LIKE '%rc.id=$3%'`);
            if (waiting.rows[0].count >= count) return;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          assert.fail('receipt deletion did not wait for the round row lock');
        };
        try {
          const f = await fixture(),
            ticket = key(),
            body = { expectedVersion: f.receipt.version! };
          const before = published;
          events = [];
          deletedKeys = [];
          await gate.query('BEGIN');
          await gate.query('SELECT id FROM rounds WHERE id=$1 FOR UPDATE', [
            f.round.id,
          ]);
          concurrent = true;
          const pending = Promise.all(
            [1, 2].map(() =>
              removeReceipt(
                author,
                ticket,
                f.round.id,
                f.expense.id,
                f.receipt.id,
                body,
                audience,
              ),
            ),
          );
          await waitForDeletes(2);
          await gate.query('COMMIT');
          const results = await pending;
          concurrent = false;
          assert.deepEqual(results[0], results[1]);
          assert.equal(results[0].version, body.expectedVersion + 1);
          assert.equal(published, before + 1);
          assert.deepEqual(deletedKeys, [f.objectKey]);
          const locked = await fixture();
          await gate.query('BEGIN');
          await gate.query('SELECT id FROM rounds WHERE id=$1 FOR UPDATE', [
            locked.round.id,
          ]);
          const pendingDeletion = removeReceipt(
            author,
            key(),
            locked.round.id,
            locked.expense.id,
            locked.receipt.id,
            { expectedVersion: locked.receipt.version! },
            audience,
          ).then(
            (result) => ({ result, error: null }),
            (error) => ({ result: null, error }),
          );
          await waitForDeletes(1);
          await gate.query(
            "UPDATE rounds SET status='CONFIRMED',confirmed_at=created_at,version=version+1 WHERE id=$1",
            [locked.round.id],
          );
          await gate.query('COMMIT');
          const outcome = await pendingDeletion;
          assert.equal(
            outcome.error?.code,
            'invalid_round_state',
            JSON.stringify(outcome),
          );
          assert.equal(
            (
              await db.query('SELECT id FROM expense_receipts WHERE id=$1', [
                locked.receipt.id,
              ])
            ).rowCount,
            1,
          );
          assert.equal(published, before + 1);
          await trace(['AUTH', 'SQL'], () =>
            assert.rejects(
              removeReceipt(
                owner,
                key(),
                locked.round.id,
                locked.expense.id,
                locked.receipt.id,
                { expectedVersion: locked.receipt.version! },
                audience,
              ),
              code('invalid_round_state'),
            ),
          );
        } finally {
          concurrent = false;
          await gate.query('ROLLBACK');
          await gate.end();
        }
      },
    );

    await t.test(
      'same key across different rounds rolls back the losing deletion and version',
      async () => {
        const fixtures = [await fixture(), await fixture()];
        const ticket = key(),
          before = published;
        const gate = createDatabaseClient(testUrl);
        await gate.connect();
        try {
          await gate.query('BEGIN');
          await gate.query(
            'SELECT id FROM rounds WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE',
            [fixtures.map((f) => f.round.id)],
          );
          concurrent = true;
          deletedKeys = [];
          const pending = Promise.allSettled(
            fixtures.map((f) =>
              removeReceipt(
                author,
                ticket,
                f.round.id,
                f.expense.id,
                f.receipt.id,
                { expectedVersion: f.receipt.version! },
                audience,
              ),
            ),
          );
          const deadline = Date.now() + 4000;
          while (true) {
            await gate.query('SELECT pg_stat_clear_snapshot()');
            const waiting =
              await gate.query(`SELECT count(DISTINCT a.pid)::int AS count FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
            WHERE a.datname=current_database() AND NOT l.granted AND a.query LIKE '%rc.id=$3%'`);
            if (waiting.rows[0].count >= 2) break;
            assert.ok(
              Date.now() < deadline,
              'both deletions must reach their saving statements',
            );
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          await gate.query('COMMIT');
          const outcomes = await pending;
          assert.equal(
            outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
            1,
          );
          assert.equal(published, before + 1);
          assert.equal(deletedKeys.length, 1);
          for (const [index, outcome] of outcomes.entries()) {
            const f = fixtures[index];
            const version = (
              await db.query('SELECT version FROM rounds WHERE id=$1', [
                f.round.id,
              ])
            ).rows[0].version;
            const receipt = await db.query(
              'SELECT id FROM expense_receipts WHERE id=$1',
              [f.receipt.id],
            );
            if (outcome.status === 'fulfilled') {
              assert.equal(version, f.receipt.version! + 1);
              assert.equal(receipt.rowCount, 0);
              assert.deepEqual(deletedKeys, [f.objectKey]);
            } else {
              assert.equal(outcome.reason.code, 'idempotency_conflict');
              assert.equal(version, f.receipt.version);
              assert.equal(receipt.rowCount, 1);
            }
          }
        } finally {
          concurrent = false;
          await gate.query('ROLLBACK');
          await gate.end();
        }
      },
    );
  } finally {
    if (queryLog === undefined) delete process.env.DB_QUERY_LOG;
    else process.env.DB_QUERY_LOG = queryLog;
    t.mock.restoreAll();
    await db.end();
  }
});

before(async () => {
  await getPrismaClient(process.env.TEST_DATABASE_URL!);
});
