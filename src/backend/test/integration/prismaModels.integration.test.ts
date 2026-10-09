import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrismaService } from '../../global/database/prisma.service';
import { MutationRepository } from '../../global/database/mutation.repository';
import { MutationExecutor } from '../../global/util/idempotencyUtil';
import { SettleRepository } from '../../domain/settle/repository/settle.repository';
import { createDatabaseClient } from '../../global/database/db';
import { readAccessToken } from '../../global/auth/native';
import {
  acceptInvite,
  createGroup,
  createInvite,
  createRound,
  signInKakao,
  testProvider,
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

test('registered Prisma repositories preserve SQL counts, version races, replay and database error rollback', async (t) => {
  const db = createDatabaseClient(url);
  await db.connect();
  t.after(() => db.end());
  await applyMigrations(db);
  const actor = async (name: string) => {
    const session = await signInKakao(`prisma-model:${randomUUID()}`, {
      displayName: name,
      email: null,
      profileImageUrl: null,
    });
    const account = await completeTestOnboarding(
      readAccessToken(session.accessToken),
      {
        bankName: '검증 은행',
        accountNumber: '12340312345678',
        accountHolder: name,
      },
    );
    return readAccessToken(account.accessToken)!;
  };
  const a = await actor('모델 생성자'),
    b = await actor('모델 참여자');
  const group = await createGroup(a, uuidV7(), { name: 'Prisma 모델 검증' });
  const invite = await createInvite(a, randomUUID(), group.id, {});
  await acceptInvite(b, randomUUID(), invite.sharePath!.split('/').at(-1)!);
  const round = await createRound(a, uuidV7(), group.id, {
    name: '조건부 모델 갱신',
    participantIds: [a.userId, b.userId],
  });
  const prisma = await testProvider(PrismaService);
  const requests = await testProvider(MutationRepository);
  const settle = await testProvider(SettleRepository);
  const executor = await testProvider(MutationExecutor);
  const client = prisma.connection();
  const previous = process.env.DB_QUERY_LOG;
  process.env.DB_QUERY_LOG = 'true';
  t.after(() => {
    if (previous === undefined) delete process.env.DB_QUERY_LOG;
    else process.env.DB_QUERY_LOG = previous;
  });
  let statements: string[] = [];
  t.mock.method(console, 'info', (message: string) => {
    statements.push(
      message
        .replace(/^SQL:\s*/, '')
        .replace(/\s+/g, ' ')
        .trim(),
    );
  });
  const trace = async <T>(count: number, work: () => Promise<T>) => {
    statements = [];
    const result = await work();
    assert.equal(statements.length, count, statements.join('\n'));
    return result;
  };

  await t.test(
    'a model read is one SELECT and competing conditional updates have one winner',
    async () => {
      assert.equal(
        await trace(1, () => settle.hasRemainder(client, round.id)),
        false,
      );
      assert.match(statements[0], /^SELECT .*FROM "public"\."expenses"/);
      // Production uses an existing transaction; each competing transaction has
      // BEGIN, one conditional UPDATE RETURNING and COMMIT, with no extra read.
      const winners = await trace(6, () =>
        Promise.all([
          prisma.client.$transaction((tx) =>
            settle.bumpRound(prisma.connection(tx), round.id, 1),
          ),
          prisma.client.$transaction((tx) =>
            settle.bumpRound(prisma.connection(tx), round.id, 1),
          ),
        ]),
      );
      assert.equal(winners.filter(Boolean).length, 1);
      assert.equal(winners.find(Boolean)?.version, 2);
      assert.equal(
        statements.filter((sql) => /^UPDATE .*"rounds".*RETURNING/.test(sql))
          .length,
        2,
      );
      assert.equal(statements.filter((sql) => sql === 'BEGIN').length, 2);
      assert.equal(statements.filter((sql) => sql === 'COMMIT').length, 2);
    },
  );

  await t.test(
    'model writes preserve unique and foreign-key SQLSTATE and constraint names',
    async () => {
      const key = randomUUID();
      await trace(1, () =>
        requests.save(
          client,
          a.userId,
          'model.probe',
          key,
          'digest',
          round.id,
          { id: round.id },
        ),
      );
      await trace(1, () =>
        assert.rejects(
          requests.save(
            client,
            a.userId,
            'model.probe',
            key,
            'digest',
            round.id,
            { id: round.id },
          ),
          (error: { code: string; constraint: string; cause: unknown }) =>
            error.code === '23505' &&
            error.constraint === 'mutation_requests_pkey' &&
            !!error.cause,
        ),
      );
      await trace(1, () =>
        assert.rejects(
          requests.save(
            client,
            randomUUID(),
            'model.probe',
            randomUUID(),
            'digest',
            round.id,
            { id: round.id },
          ),
          (error: { code: string; constraint: string }) =>
            error.code === '23503' &&
            error.constraint === 'mutation_requests_actor_id_fkey',
        ),
      );
    },
  );

  await t.test(
    'a CHECK failure rolls back the preceding model update; successful replay skips work',
    async () => {
      const key = randomUUID(),
        payload = { expectedVersion: 2 };
      const constraint = `prisma_model_${randomUUID().replaceAll('-', '')}`;
      await db.query(
        `ALTER TABLE mutation_requests ADD CONSTRAINT ${constraint} CHECK (request_key <> '${key}') NOT VALID`,
      );
      const work = async (
        transaction: Parameters<SettleRepository['bumpRound']>[0],
      ) => {
        const changed = await settle.bumpRound(transaction, round.id, 2);
        assert.ok(changed);
        return changed;
      };
      try {
        await trace(7, () =>
          assert.rejects(
            executor.execute(a, key, 'model.probe', payload, work),
            (error: { code: string; constraint: string }) =>
              error.code === '23514' && error.constraint === constraint,
          ),
        );
        assert.equal(statements[0], 'BEGIN');
        assert.equal(statements.at(-1), 'ROLLBACK');
        assert.equal(
          (await db.query('SELECT version FROM rounds WHERE id=$1', [round.id]))
            .rows[0].version,
          2,
        );
        assert.equal(
          (
            await db.query(
              'SELECT 1 FROM mutation_requests WHERE request_key=$1',
              [key],
            )
          ).rowCount,
          0,
        );
      } finally {
        await db.query(
          `ALTER TABLE mutation_requests DROP CONSTRAINT ${constraint}`,
        );
      }
      const result = await trace(7, () =>
        executor.execute(a, key, 'model.probe', payload, work),
      );
      assert.equal(statements.at(-1), 'COMMIT');
      assert.deepEqual(
        await trace(5, () =>
          executor.execute(a, key, 'model.probe', payload, async () =>
            assert.fail('replay invoked work'),
          ),
        ),
        result,
      );
      await trace(5, () =>
        assert.rejects(
          executor.execute(
            a,
            key,
            'model.probe',
            { expectedVersion: 3 },
            async () => assert.fail('conflict invoked work'),
          ),
          (error: { code: string }) => error.code === 'idempotency_conflict',
        ),
      );
    },
  );
});
