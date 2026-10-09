import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import sharp from 'sharp';
import { createBackend } from '../../domain/main';
import { SettleService } from '../../domain/settle/service/settle.service';
import { createDatabaseClient } from '../../global/database/db';
import { createAccessToken, readAccessToken } from '../../global/auth/native';
import {
  acceptInvite,
  createGroup,
  createInvite,
  createRound,
  saveExpense,
  signInKakao,
} from '../support/domainTestSupport';
import { completeTestOnboarding } from './bankTestSupport';
import { drainReceiptQueue } from './receiptWorkerTestSupport';
import { applyMigrations } from '../../../../scripts/migrations.mjs';
import { uuidV7 } from '../../../shared/uuid';

const url = process.env.TEST_DATABASE_URL;
if (
  !url ||
  !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname) ||
  !new URL(url).pathname.includes('test')
)
  throw new Error('An isolated local test database is required');
process.env.DATABASE_URL = url;

test('receipt HTTP admits resource access before any upload bytes and rechecks authorization atomically while preserving replay', async (t) => {
  const db = createDatabaseClient(url);
  await db.connect();
  t.after(() => db.end());
  await applyMigrations(db);
  const member = async () => {
    const session = await signInKakao(`receipt-admission:${randomUUID()}`, {
      displayName: '업로드 권한',
      email: null,
      profileImageUrl: null,
    });
    return completeTestOnboarding(readAccessToken(session.accessToken), {
      bankName: '검증은행',
      accountNumber: '12340312345678',
      accountHolder: '업로드 권한',
    });
  };
  const owner = await member(),
    author = await member(),
    viewer = await member(),
    outsider = await member();
  const ownerAccess = readAccessToken(owner.accessToken)!;
  const authorAccess = readAccessToken(author.accessToken)!;
  const group = await createGroup(ownerAccess, uuidV7(), {
    name: '파일 읽기 전 권한',
  });
  const invite = await createInvite(ownerAccess, randomUUID(), group.id, {});
  for (const user of [author, viewer])
    await acceptInvite(
      readAccessToken(user.accessToken),
      randomUUID(),
      invite.sharePath!.split('/').at(-1)!,
    );
  const round = await createRound(ownerAccess, uuidV7(), group.id, {
    name: '업로드',
    participantIds: [owner.userId, author.userId, viewer.userId],
  });
  const expense = await saveExpense(authorAccess, randomUUID(), round.id, {
    currency: 'KRW',
    description: '영수증',
    amount: '10',
    payerId: author.userId,
    splitMode: 'ALL',
    expectedVersion: round.version,
  });
  const { app } = await createBackend();
  t.after(() => app.close());
  await app.listen(0, '127.0.0.1');
  const origin = await app.getUrl();
  const path = `/api/rounds/${round.id}/expenses/${expense.id}/receipts`;
  const previous = process.env.DB_QUERY_LOG;
  process.env.DB_QUERY_LOG = 'true';
  t.after(() => {
    if (previous === undefined) delete process.env.DB_QUERY_LOG;
    else process.env.DB_QUERY_LOG = previous;
  });
  let sql: string[] = [];
  t.mock.method(console, 'info', (message: string) => {
    if (message.startsWith('SQL:')) sql.push(message);
  });
  // Send headers alone. Receiving a denial proves that resource authorization
  // neither waits for nor buffers the advertised multipart payload.
  const headersOnly = (token: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest(
        `${origin}${path}`,
        {
          method: 'POST',
          headers: {
            origin,
            authorization: `Bearer ${token}`,
            'idempotency-key': randomUUID(),
            'content-type': 'multipart/form-data; boundary=not-sent',
            'content-length': '11000000',
            connection: 'close',
          },
        },
        (response) => {
          let body = '';
          response.on('data', (bytes) => {
            body += bytes;
          });
          response.on('error', reject);
          response.on('end', () => {
            resolve({ status: response.statusCode!, body });
            request.destroy();
          });
        },
      );
      request.on('error', reject);
      request.setTimeout(2000, () =>
        request.destroy(new Error('Authorization waited for upload bytes')),
      );
      request.flushHeaders();
    });
  for (const [token, status, count] of [
    [viewer.accessToken, 403, 2],
    [outsider.accessToken, 404, 2],
    [createAccessToken(randomUUID(), randomUUID()), 401, 1],
    ['invalid', 401, 0],
  ] as const) {
    sql = [];
    const response = await headersOnly(token);
    assert.equal(response.status, status, response.body);
    assert.equal(sql.length, count, sql.join('\n'));
  }
  const bytes = await sharp({
    create: { width: 2, height: 2, channels: 3, background: '#369' },
  })
    .avif()
    .toBuffer();
  const upload = async (key: string, expectedVersion = expense.version!) => {
    const form = new FormData();
    form.set('file', new File([bytes], 'receipt.avif', { type: 'image/avif' }));
    form.set('expectedVersion', String(expectedVersion));
    return fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        origin,
        authorization: `Bearer ${author.accessToken}`,
        'idempotency-key': key,
      },
      body: form,
      signal: AbortSignal.timeout(10000),
    });
  };
  const key = randomUUID();
  sql = [];
  const accepted = await upload(key);
  assert.equal(accepted.status, 202, await accepted.clone().text());
  const result = (await accepted.json()).data;
  assert.equal(sql.length, 3, sql.join('\n'));
  await drainReceiptQueue();
  await db.query('DELETE FROM expenses WHERE id=$1', [expense.id]);
  sql = [];
  const replay = await upload(key);
  assert.equal(replay.status, 202, await replay.clone().text());
  assert.deepEqual((await replay.json()).data, result);
  assert.equal(sql.length, 3, sql.join('\n'));
  const changed = await upload(key, expense.version! + 1);
  assert.equal(changed.status, 409);
  assert.equal((await changed.json()).code, 'idempotency_conflict');

  // An admitted user can lose access before the atomic save; admission is no
  // substitute for the existing write-time checks.
  const nextExpense = await saveExpense(authorAccess, randomUUID(), round.id, {
    currency: 'KRW',
    description: '경합',
    amount: '10',
    payerId: author.userId,
    splitMode: 'ALL',
    expectedVersion: result.version,
  });
  const service = app.get(SettleService);
  const admission = await service.admitReceipt(
    authorAccess,
    randomUUID(),
    round.id,
    nextExpense.id,
  );
  await db.query(
    'UPDATE round_members SET excluded_at=1 WHERE round_id=$1 AND user_id=$2',
    [round.id, author.userId],
  );
  await assert.rejects(
    service.saveReceipt(admission, {
      expectedVersion: nextExpense.version!,
      bytes,
      type: 'image/avif',
      name: 'receipt.avif',
    }),
    (error: unknown) => (error as { code: string }).code === 'forbidden',
  );
  const persisted = await db.query('SELECT version FROM rounds WHERE id=$1', [
    round.id,
  ]);
  assert.equal(persisted.rows[0].version, nextExpense.version);
  const recorded = await db.query(
    'SELECT count(*)::int AS n FROM mutation_requests WHERE actor_id=$1 AND request_key=$2',
    [author.userId, admission.key],
  );
  assert.equal(recorded.rows[0].n, 0);
});
