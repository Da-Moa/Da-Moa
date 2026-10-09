import { testProvider } from '../support/domainTestSupport';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createDatabaseClient } from '../../global/database/db';

import type { AccessToken } from '../../global/auth/native';
import {
  createGroup,
  createInvite,
  acceptInvite,
  createRound,
  saveExpense,
  roundCommand,
} from '../support/domainTestSupport';
import { SettleRepository } from '../../domain/settle/repository/settle.repository';
import {
  finalizeCurrencySettlement,
  type Currency,
} from '../../../shared/domain/settle';
import { uuidV7 } from '../../../shared/uuid';
import { applyMigrations } from '../../../../scripts/migrations.mjs';

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

test('send bulk-finalizes settlement with constant SQL count, exact money and atomic rollback', async (t) => {
  const previousQueryLog = process.env.DB_QUERY_LOG;
  process.env.DB_QUERY_LOG = 'false';
  t.after(() => {
    if (previousQueryLog === undefined) delete process.env.DB_QUERY_LOG;
    else process.env.DB_QUERY_LOG = previousQueryLog;
  });
  const db = createDatabaseClient(database);
  await db.connect();
  t.after(async () => {
    await db.end();
  });
  await applyMigrations(db);
  const people: AccessToken[] = [];
  for (let index = 0; index < 4; index++) {
    const userId = randomUUID();
    await db.query(
      `INSERT INTO users(id,provider,provider_subject,display_name,created_at,updated_at,
      onboarding_completed_at,bank_name,account_number,account_holder,bank_updated_at)
      VALUES($1,'test',$1,$2,1,1,1,'테스트 은행','12340312345678',$2,1)`,
      [userId, `벌크 ${index}`],
    );
    people.push({ userId, sessionId: randomUUID(), issuedAt: 1 });
  }
  const owner = people[0];
  const group = await createGroup(owner, uuidV7(), { name: '벌크 정산 검증' });
  const invite = await createInvite(owner, randomUUID(), group.id, {});
  for (const person of people.slice(1))
    await acceptInvite(
      person,
      randomUUID(),
      invite.sharePath!.split('/').at(-1)!,
    );
  const repository = await testProvider(SettleRepository);

  type ExpenseInput = {
    currency: Currency;
    amount: string;
    amountMinor: string;
    payer: number;
  };
  const fixture = async (specs: ExpenseInput[], count = 2) => {
    const participants = people.slice(0, count);
    const round = await createRound(owner, uuidV7(), group.id, {
      name: '벌크 회차',
      participantIds: participants.map((person) => person.userId),
    });
    let version = 1;
    const expenses = [];
    for (const spec of specs) {
      const saved = await saveExpense(owner, randomUUID(), round.id, {
        description: '벌크 지출',
        currency: spec.currency,
        amount: spec.amount,
        payerId: people[spec.payer].userId,
        splitMode: 'ALL',
        expectedVersion: version,
      });
      version = saved.version!;
      expenses.push({
        id: saved.id,
        currency: spec.currency,
        amountMinor: spec.amountMinor,
        payerId: people[spec.payer].userId,
        participantIds: participants.map((person) => person.userId),
      });
    }
    const confirmed = await roundCommand(
      owner,
      randomUUID(),
      round.id,
      'confirm',
      { expectedVersion: version },
    );
    return {
      roundId: round.id,
      version: confirmed.version!,
      expenses,
      participants,
    };
  };
  const trace = async <T>(work: () => Promise<T>) => {
    const previous = process.env.DB_QUERY_LOG;
    process.env.DB_QUERY_LOG = 'true';
    const statements: string[] = [];
    const logger = t.mock.method(console, 'info', (message: string) =>
      statements.push(
        message
          .replace(/^SQL:\s*/, '')
          .replace(/\s+/g, ' ')
          .trim(),
      ),
    );
    try {
      return { result: await work(), statements };
    } finally {
      logger.mock.restore();
      if (previous === undefined) delete process.env.DB_QUERY_LOG;
      else process.env.DB_QUERY_LOG = previous;
    }
  };
  const send = (
    round: Awaited<ReturnType<typeof fixture>>,
    key = randomUUID(),
  ) =>
    trace(() =>
      roundCommand(owner, key, round.roundId, 'send', {
        expectedVersion: round.version,
      }),
    );
  const bulkCount = (statements: string[]) =>
    statements.filter(
      (sql) =>
        sql.includes('jsonb_to_recordset') &&
        sql.includes('INSERT INTO settlement_balances') &&
        sql.includes('INSERT INTO settlement_transfers'),
    ).length;
  const sorted = <T>(rows: T[]) =>
    rows
      .slice()
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const assertPersisted = async (
    round: Awaited<ReturnType<typeof fixture>>,
  ) => {
    const expected = finalizeCurrencySettlement(
      round.expenses,
      round.participants.map((person) => person.userId),
    );
    const shares = (
      await db.query(
        `SELECT expense_id AS "expenseId",user_id AS "userId",
      final_amount_minor::text AS "amountMinor",received_remainder AS "receivedRemainder"
      FROM expense_shares WHERE round_id=$1`,
        [round.roundId],
      )
    ).rows;
    const balances = (
      await db.query(
        `SELECT user_id AS "userId",paid_minor::text AS "paidMinor",
      burden_minor::text AS "burdenMinor",balance_minor::text AS "balanceMinor",currency
      FROM settlement_balances WHERE round_id=$1`,
        [round.roundId],
      )
    ).rows;
    const transfers = (
      await db.query(
        `SELECT sender_id AS "senderId",receiver_id AS "receiverId",
      amount_minor::text AS "amountMinor",currency FROM settlement_transfers WHERE round_id=$1`,
        [round.roundId],
      )
    ).rows;
    assert.deepEqual(sorted(shares), sorted(expected.shares));
    assert.deepEqual(sorted(balances), sorted(expected.balances));
    assert.deepEqual(sorted(transfers), sorted(expected.transfers));
    const state = (
      await db.query(
        'SELECT status,version,finalized_at,completed_at FROM rounds WHERE id=$1',
        [round.roundId],
      )
    ).rows[0];
    assert.equal(state.status, 'LOCKED');
    assert.equal(state.version, round.version + 1);
    assert.notEqual(state.finalized_at, null);
    assert.equal(state.completed_at, null);
  };
  const assertUnchanged = async (
    round: Awaited<ReturnType<typeof fixture>>,
    key: string,
  ) => {
    const state = (
      await db.query(
        'SELECT status,version,locked_at,finalized_at FROM rounds WHERE id=$1',
        [round.roundId],
      )
    ).rows[0];
    assert.deepEqual(state, {
      status: 'CONFIRMED',
      version: round.version,
      locked_at: null,
      finalized_at: null,
    });
    assert.equal(
      (
        await db.query(
          'SELECT 1 FROM expense_shares WHERE round_id=$1 AND final_amount_minor IS NOT NULL',
          [round.roundId],
        )
      ).rowCount,
      0,
    );
    for (const table of ['settlement_balances', 'settlement_transfers'])
      assert.equal(
        (
          await db.query(`SELECT 1 FROM ${table} WHERE round_id=$1`, [
            round.roundId,
          ])
        ).rowCount,
        0,
      );
    assert.equal(
      (
        await db.query(
          'SELECT 1 FROM mutation_requests WHERE actor_id=$1 AND operation=$2 AND request_key=$3',
          [owner.userId, 'round.send', key],
        )
      ).rowCount,
      0,
    );
  };
  const simple = {
    currency: 'KRW',
    amount: '100',
    amountMinor: '100',
    payer: 0,
  } as const;

  await t.test(
    'one expense and two members use one persistence statement; replay does not save again',
    async () => {
      const round = await fixture([simple]);
      const key = randomUUID();
      const first = await send(round, key);
      assert.equal(first.statements.length, 13, first.statements.join('\n'));
      assert.equal(bulkCount(first.statements), 1);
      assert.equal(first.statements[0], 'BEGIN');
      assert.equal(first.statements.at(-1), 'COMMIT');
      await assertPersisted(round);
      const replay = await send(round, key);
      assert.deepEqual(replay.result, first.result);
      assert.equal(replay.statements.length, 5);
      assert.equal(bulkCount(replay.statements), 0);
      await assertPersisted(round);
    },
  );
  await t.test(
    'many shares, members and currencies keep the same SQL count and do not affect another round',
    async () => {
      const untouched = await fixture([simple]);
      const round = await fixture(
        [
          simple,
          { currency: 'KRW', amount: '200', amountMinor: '200', payer: 1 },
          { currency: 'USD', amount: '8.00', amountMinor: '800', payer: 2 },
          { currency: 'JPY', amount: '400', amountMinor: '400', payer: 3 },
        ],
        4,
      );
      const { statements } = await send(round);
      assert.equal(statements.length, 13, statements.join('\n'));
      assert.equal(bulkCount(statements), 1);
      await assertPersisted(round);
      await assertUnchanged(untouched, randomUUID());
    },
  );
  await t.test(
    'balanced payments finalize successfully with an empty transfer array',
    async () => {
      const round = await fixture([simple, { ...simple, payer: 1 }]);
      const { statements } = await send(round);
      assert.equal(statements.length, 13);
      assert.equal(bulkCount(statements), 1);
      await assertPersisted(round);
      assert.equal(
        (
          await db.query(
            'SELECT 1 FROM settlement_transfers WHERE round_id=$1',
            [round.roundId],
          )
        ).rowCount,
        0,
      );
    },
  );
  await t.test(
    'a transfer constraint failure rolls back every bulk write and the round lock',
    async () => {
      const round = await fixture([simple]);
      const key = randomUUID();
      const original = repository.saveFinalSettlement.bind(repository);
      const failure = t.mock.method(
        repository,
        'saveFinalSettlement',
        (...[client, roundId, result, now]: Parameters<typeof original>) =>
          original(
            client,
            roundId,
            {
              ...result,
              transfers: result.transfers.map((transfer) => ({
                ...transfer,
                amountMinor: '-1',
              })),
            },
            now,
          ),
      );
      try {
        await assert.rejects(
          send(round, key),
          (error: { code?: string }) => error.code === '23514',
        );
      } finally {
        failure.mock.restore();
      }
      await assertUnchanged(round, key);
      await send(round, key);
      await assertPersisted(round);
    },
  );
  await t.test(
    'failure after successful bulk persistence rolls back results and leaves the retry usable',
    async () => {
      const round = await fixture([simple]);
      const key = randomUUID();
      const original = repository.saveFinalSettlement.bind(repository);
      const failure = t.mock.method(
        repository,
        'saveFinalSettlement',
        async (...args: Parameters<typeof original>) => {
          await original(...args);
          throw new Error('failure after bulk persistence');
        },
      );
      try {
        await assert.rejects(
          send(round, key),
          /failure after bulk persistence/,
        );
      } finally {
        failure.mock.restore();
      }
      await assertUnchanged(round, key);
      await send(round, key);
      await assertPersisted(round);
    },
  );
  await t.test(
    'send with a remainder defers persistence until draw',
    async () => {
      const round = await fixture([simple], 3);
      const { result, statements } = await send(round);
      assert.equal(bulkCount(statements), 0);
      assert.equal(
        (
          await db.query('SELECT finalized_at FROM rounds WHERE id=$1', [
            round.roundId,
          ])
        ).rows[0].finalized_at,
        null,
      );
      assert.ok(result.version !== undefined);
      const drawn = await roundCommand(
        owner,
        randomUUID(),
        round.roundId,
        'draw',
        { expectedVersion: result.version },
      );
      assert.equal(drawn.status, 'LOCKED');
      assert.notEqual(
        (
          await db.query('SELECT finalized_at FROM rounds WHERE id=$1', [
            round.roundId,
          ])
        ).rows[0].finalized_at,
        null,
      );
      assert.equal(
        (
          await db.query(
            'SELECT COUNT(*)::int AS n FROM expense_shares WHERE round_id=$1 AND received_remainder=true',
            [round.roundId],
          )
        ).rows[0].n,
        1,
      );
    },
  );
});
