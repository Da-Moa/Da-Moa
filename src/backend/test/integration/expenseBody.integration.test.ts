import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createBackend } from '../../domain/main';
import { SettleService } from '../../domain/settle/service/settle.service';
import {
  CreateExpenseRequestDTO,
  ExpenseRequestDTO,
} from '../../domain/settle/dto/req/settle.request.dto';
import { createDatabaseClient } from '../../global/database/db';
import { readAccessToken } from '../support/legacyTokenTestSupport.ts';
import {
  acceptInvite,
  createGroup,
  createInvite,
  createRound,
  signInKakao,
} from '../support/domainTestSupport';
import { completeTestOnboarding } from './bankTestSupport';
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

test('expense HTTP separates create/update DTOs, preserves trimmed UTF-16 limits and hashes original field values for replay', async (t) => {
  const db = createDatabaseClient(url);
  await db.connect();
  t.after(() => db.end());
  await applyMigrations(db);
  const member = async () => {
    const session = await signInKakao(`expense-body:${randomUUID()}`, {
      displayName: '지출 DTO 검증',
      email: null,
      profileImageUrl: null,
    });
    return completeTestOnboarding(readAccessToken(session.accessToken), {
      bankName: '검증 은행',
      accountNumber: '12340312345678',
      accountHolder: '지출 DTO 검증',
    });
  };
  const a = await member(),
    b = await member();
  const actor = readAccessToken(a.accessToken)!;
  const group = await createGroup(actor, uuidV7(), { name: '지출 DTO' });
  const invite = await createInvite(actor, randomUUID(), group.id, {});
  await acceptInvite(
    readAccessToken(b.accessToken),
    randomUUID(),
    invite.sharePath!.split('/').at(-1)!,
  );
  const round = await createRound(actor, uuidV7(), group.id, {
    name: '지출 경계',
    participantIds: [a.userId, b.userId],
  });
  const { app } = await createBackend();
  t.after(() => app.close());
  await app.listen(0, '127.0.0.1');
  const origin = await app.getUrl();
  const service = app.get(SettleService);
  for (const [method, dto] of [
    ['createExpense', CreateExpenseRequestDTO],
    ['updateExpense', ExpenseRequestDTO],
  ] as const) {
    const original = service[method].bind(service);
    t.mock.method(service, method, async (...args: unknown[]) => {
      assert.ok(args[3] instanceof dto);
      const before = JSON.stringify(args[3]);
      try {
        return await Reflect.apply(original, service, args);
      } finally {
        assert.equal(
          JSON.stringify(args[3]),
          before,
          'the original DTO remains available for idempotency hashing',
        );
      }
    });
  }
  const previous = process.env.DB_QUERY_LOG;
  process.env.DB_QUERY_LOG = 'true';
  t.after(() => {
    if (previous === undefined) delete process.env.DB_QUERY_LOG;
    else process.env.DB_QUERY_LOG = previous;
  });
  let sql: string[] = [];
  t.mock.method(console, 'info', (message: string) => {
    sql.push(
      message
        .replace(/^SQL:\s*/, '')
        .replace(/\s+/g, ' ')
        .trim(),
    );
  });
  const request = async (
    body: object,
    status: number,
    count: number,
    expenseId?: string,
    key = randomUUID(),
  ) => {
    sql = [];
    const response = await fetch(
      `${origin}/api/rounds/${round.id}/expenses${expenseId ? `/${expenseId}` : ''}`,
      {
        method: expenseId ? 'PATCH' : 'POST',
        headers: {
          origin,
          authorization: `Bearer ${a.accessToken}`,
          'content-type': 'application/json',
          'idempotency-key': key,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      },
    );
    const payload = await response.json();
    assert.equal(response.status, status, JSON.stringify(payload));
    assert.equal(sql.length, count, sql.join('\n'));
    if (count) assert.match(sql[0], /"users" WHERE .*"id" = \$1/);
    if (count >= 5) {
      assert.equal(sql[expenseId ? 2 : 1], 'BEGIN');
      assert.equal(
        sql[expenseId ? 3 : 2],
        'SELECT pg_advisory_xact_lock(1684106607)::text',
      );
      assert.equal(sql.at(-1), status === 200 ? 'COMMIT' : 'ROLLBACK');
    }
    return payload;
  };
  const input = {
    currency: 'KRW',
    description: ` \t${'가'.repeat(500)}\n `,
    amount: '100',
    payerId: ` ${a.userId} `,
    splitMode: 'ALL',
    expectedVersion: 1,
  };
  for (const expenseId of [undefined, randomUUID()]) {
    for (const description of ['가'.repeat(501), '😀'.repeat(251)]) {
      const error = await request({ ...input, description }, 400, 0, expenseId);
      assert.equal(error.code, 'invalid_input');
      assert.equal(error.detail, null);
      assert.equal('details' in error, false);
    }
    for (const payerId of ['', ' '.repeat(128), '😀'.repeat(65)]) {
      const error = await request({ ...input, payerId }, 400, 0, expenseId);
      assert.equal(error.code, 'invalid_input');
      assert.equal(error.detail, null);
    }
    for (const payerId of [123, null, ' '.repeat(129)]) {
      const error = await request({ ...input, payerId }, 400, 0, expenseId);
      assert.equal(error.code, 'invalid_participants');
      assert.deepEqual(error.detail, { field: 'payerId' });
    }
  }
  for (const field of [
    'currency',
    'description',
    'amount',
    'payerId',
    'splitMode',
  ] as const) {
    const body = { ...input };
    delete (body as Partial<typeof input>)[field];
    await request(body, 400, 0);
  }
  assert.equal(
    (await request({ ...input, splitMode: 'SELECTED' }, 400, 1)).message,
    '참여자를 중복 없이 선택해 주세요',
  );
  const duplicated = await request(
    {
      ...input,
      splitMode: 'CUSTOM',
      customShares: [
        { userId: a.userId, amount: '50' },
        { userId: a.userId, amount: '50' },
      ],
    },
    400,
    1,
  );
  assert.equal(duplicated.code, 'invalid_participants');
  assert.equal(duplicated.message, '참여자를 중복 없이 선택해 주세요');
  assert.equal(duplicated.detail, null);
  const ticket = randomUUID();
  const saved = (await request(input, 200, 6, undefined, ticket)).data;
  assert.deepEqual(
    (await request(input, 200, 5, undefined, ticket)).data,
    saved,
  );
  assert.equal(
    (
      await request(
        { ...input, description: input.description.trim() },
        409,
        5,
        undefined,
        ticket,
      )
    ).code,
    'idempotency_conflict',
  );
  const persisted = async () =>
    (
      await db.query('SELECT description,payer_id FROM expenses WHERE id=$1', [
        saved.id,
      ])
    ).rows[0];
  assert.deepEqual(await persisted(), {
    description: input.description.trim(),
    payer_id: a.userId,
  });
  const outsider = randomUUID();
  const duplicatePatch = await request(
    {
      splitMode: 'CUSTOM',
      expectedVersion: saved.version,
      customShares: [
        { userId: outsider, amount: '50' },
        { userId: outsider, amount: '50' },
      ],
    },
    400,
    2,
    saved.id,
  );
  assert.equal(duplicatePatch.code, 'invalid_participants');
  assert.equal(duplicatePatch.message, '참여자를 중복 없이 선택해 주세요');
  assert.equal(duplicatePatch.detail, null);
  const patchKey = randomUUID();
  const patch = {
    description: ` ${'😀'.repeat(250)} `,
    expectedVersion: saved.version,
  };
  const updated = (await request(patch, 200, 6, saved.id, patchKey)).data;
  assert.deepEqual(
    (await request(patch, 200, 2, saved.id, patchKey)).data,
    updated,
  );
  assert.equal(
    (
      await request(
        { ...patch, description: patch.description.trim() },
        409,
        2,
        saved.id,
        patchKey,
      )
    ).code,
    'idempotency_conflict',
  );
  assert.deepEqual(await persisted(), {
    description: patch.description.trim(),
    payer_id: a.userId,
  });
  const currency = await request(
    { currency: 'USD', expectedVersion: updated.version },
    400,
    2,
    saved.id,
  );
  assert.equal(currency.code, 'invalid_amount');
  assert.equal(currency.message, '통화를 변경할 때 금액을 다시 입력해 주세요');
  const unchanged = (
    await request({ expectedVersion: updated.version }, 200, 6, saved.id)
  ).data;
  assert.equal(unchanged.version, updated.version + 1);
  assert.deepEqual(await persisted(), {
    description: patch.description.trim(),
    payer_id: a.userId,
  });
});
