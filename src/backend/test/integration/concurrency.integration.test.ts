import {
  mockPoolConnection,
  queryText,
  queryResult,
} from '../support/dbTestSupport.ts';
import { getPrismaClient } from '../support/domainTestSupport.ts';
import { uuidV7 } from '../../../shared/uuid.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { before, test } from 'node:test';
import sharp from 'sharp';
import {
  currentTimestamp,
  type AccessToken,
} from '../../global/auth/native.ts';
import { readAccessToken } from '../support/legacyTokenTestSupport.ts';
import { withdrawAccount } from '../support/domainTestSupport.ts';
import { signInKakao } from '../support/domainTestSupport.ts';
import { createDatabaseClient } from '../../global/database/db.ts';
import { getDatabasePool } from '../support/domainTestSupport.ts';
import { AppError } from '../../global/apiPayload/errors.ts';
import {
  acceptInvite,
  createGroup,
  createInvite,
  leaveGroup,
} from '../support/domainTestSupport.ts';
import {
  addReceipt,
  createRound,
  deleteExpense,
  getRound,
  getSettlement,
  roundCommand,
  saveExpense,
  setSettlementCheck,
} from '../support/domainTestSupport.ts';
import { applyMigrations } from '../../../../scripts/migrations.mjs';
import { completeTestOnboarding as completeOnboarding } from '../support/bankTestSupport.ts';

const testUrl = process.env.TEST_DATABASE_URL;
if (
  !testUrl ||
  !['localhost', '127.0.0.1', '[::1]'].includes(new URL(testUrl).hostname) ||
  !new URL(testUrl).pathname.toLowerCase().includes('test')
)
  throw new Error(
    'TEST_DATABASE_URL must name an isolated local test database',
  );
const applicationName = `settlement-concurrency-${randomUUID()}`;
const runtimeUrl = new URL(testUrl);
runtimeUrl.searchParams.set('application_name', applicationName);
process.env.DATABASE_URL = runtimeUrl.toString();
process.env.AUTH_JWT_SECRET ||=
  'integration-only-not-a-production-secret-0123456789';
const key = () => randomUUID();
const avif = await sharp({
  create: { width: 2, height: 2, channels: 3, background: '#fff' },
})
  .avif()
  .toBuffer();

async function member(): Promise<AccessToken> {
  const limited = await signInKakao(`concurrency-test:${key()}`, {
    displayName: '경합 검증 사용자',
    email: null,
    profileImageUrl: null,
  });
  const full = await completeOnboarding(readAccessToken(limited.accessToken), {
    bankName: '테스트 은행',
    accountHolder: '경합 검증 사용자',
    accountNumber: '12340312345678',
  });
  return readAccessToken(full.accessToken)!;
}

async function group(join = true) {
  const owner = await member(),
    participant = await member();
  const group = await createGroup(owner, uuidV7(), { name: '경합 검증 모임' });
  const invitation = await createInvite(owner, key(), group.id, {});
  const token = invitation.sharePath!.split('/').at(-1)!;
  if (join) await acceptInvite(participant, key(), token);
  return { owner, participant, groupId: group.id, token };
}

async function recordingRound() {
  const fixture = await group();
  const round = await createRound(fixture.owner, uuidV7(), fixture.groupId, {
    name: '경합 검증 회차',
    participantIds: [fixture.owner.userId, fixture.participant.userId],
  });
  const expense = await saveExpense(fixture.participant, key(), round.id, {
    currency: 'KRW',
    description: '경합 지출',
    amount: '3',
    payerId: fixture.owner.userId,
    splitMode: 'ALL',
    expectedVersion: round.version,
  });
  return {
    ...fixture,
    roundId: round.id,
    expenseId: expense.id,
    version: expense.version!,
  };
}

async function inspect<T>(
  work: (client: ReturnType<typeof createDatabaseClient>) => Promise<T>,
) {
  const client = createDatabaseClient(testUrl!);
  try {
    await client.connect();
    return await work(client);
  } finally {
    await client.end();
  }
}

before(async () => {
  await inspect((client) => applyMigrations(client));
});

test('회원·생성자의 모임 이탈과 회차 생성을 순서대로 처리한다', async () => {
  for (const creatorDeparture of [false, true]) {
    const fixture = await group();
    const actor = creatorDeparture ? fixture.owner : fixture.participant;
    const outcomes = await Promise.allSettled([
      createRound(fixture.owner, uuidV7(), fixture.groupId, {
        name: '탈퇴 경합 회차',
        participantIds: [fixture.owner.userId, fixture.participant.userId],
      }),
      leaveGroup(actor, key(), fixture.groupId),
    ]);
    assert.equal(
      outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
      1,
    );
    if (outcomes[0].status === 'fulfilled') {
      assert.equal(
        (outcomes[1] as PromiseRejectedResult).reason.code,
        creatorDeparture ? 'unfinished_group_rounds' : 'unfinished_rounds',
      );
      const active = await inspect(
        async (client) =>
          (
            await client.query(
              'SELECT left_at FROM group_members WHERE group_id=$1 AND user_id=$2',
              [fixture.groupId, actor.userId],
            )
          ).rows[0],
      );
      assert.equal(active.left_at, null);
    } else {
      assert.equal(
        outcomes[0].reason.code,
        creatorDeparture ? 'not_found' : 'invalid_participants',
      );
    }
  }
});

test('다시 열기와 정산 전송이 경쟁하면 하나의 상태 전환만 커밋한다', async () => {
  const fixture = await recordingRound();
  const confirmed = await roundCommand(
    fixture.owner,
    key(),
    fixture.roundId,
    'confirm',
    { expectedVersion: fixture.version },
  );
  const outcomes = await Promise.allSettled([
    roundCommand(fixture.owner, key(), fixture.roundId, 'reopen', {
      expectedVersion: confirmed.version,
    }),
    roundCommand(fixture.owner, key(), fixture.roundId, 'send', {
      expectedVersion: confirmed.version,
    }),
  ]);
  assert.equal(
    outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
    1,
  );
  const failure = outcomes.find(
    (outcome) => outcome.status === 'rejected',
  ) as PromiseRejectedResult;
  assert.ok(failure.reason instanceof AppError);
  assert.ok(
    ['stale_round', 'invalid_round_state'].includes(failure.reason.code),
  );
  const current = await getRound(
    fixture.owner,
    fixture.roundId,
    new URLSearchParams(),
  );
  assert.equal(current.version, confirmed.version! + 1);
  if (outcomes[0].status === 'fulfilled') {
    assert.equal(current.status, 'RECORDING');
    assert.equal(current.finalizedAt, null);
    const deleted = await deleteExpense(
      fixture.owner,
      key(),
      fixture.roundId,
      fixture.expenseId,
      { expectedVersion: current.version },
    );
    await roundCommand(fixture.owner, key(), fixture.roundId, 'cancel', {
      expectedVersion: deleted.version,
    });
  } else {
    assert.equal(current.status, 'LOCKED');
    const drawn = await roundCommand(
      fixture.owner,
      key(),
      fixture.roundId,
      'draw',
      { expectedVersion: current.version },
    );
    await roundCommand(
      fixture.owner,
      key(),
      fixture.roundId,
      'force-complete',
      { expectedVersion: drawn.version },
    );
  }
});

test(
  '회차 조회 이후 경쟁한 다시 열기·정산 전송 상태를 재검사한다',
  { timeout: 15000 },
  async (t) => {
    for (const [olderAction, newerAction] of [
      ['reopen', 'reopen'],
      ['reopen', 'send'],
      ['send', 'reopen'],
    ]) {
      const fixture = await recordingRound();
      const confirmed = await roundCommand(
        fixture.owner,
        key(),
        fixture.roundId,
        'confirm',
        { expectedVersion: fixture.version },
      );
      const body = { expectedVersion: confirmed.version };
      const pool = await getDatabasePool(process.env.DATABASE_URL!),
        connect = pool.connect.bind(pool);
      let resume!: () => void, reached!: () => void;
      const paused = new Promise<void>((resolve) => {
          reached = resolve;
        }),
        gate = new Promise<void>((resolve) => {
          resume = resolve;
        });
      const connectionMock = mockPoolConnection(t, pool, async () => {
        connectionMock.mock.restore();
        const borrowed = await connect();
        const queryMock = t.mock.method(
          borrowed,
          'query',
          new Proxy(borrowed.query, {
            apply(target, receiver, args) {
              return queryResult(args, (args) => {
                const pending = Reflect.apply(target, receiver, args);
                if (
                  queryText(args[0]).includes('FROM rounds r JOIN groups g')
                ) {
                  queryMock.mock.restore();
                  return pending.then(async (result: unknown) => {
                    reached();
                    await gate;
                    return result;
                  });
                }
                return pending;
              });
            },
          }),
        );
        return borrowed;
      });
      const older = roundCommand(
        fixture.owner,
        key(),
        fixture.roundId,
        olderAction,
        body,
        () => assert.fail('losing transition must not publish'),
      ).then(
        (result) => ({ result, error: undefined }),
        (error) => ({ result: undefined, error }),
      );
      try {
        await paused;
        const winner = await roundCommand(
          fixture.owner,
          key(),
          fixture.roundId,
          newerAction,
          body,
        );
        resume();
        assert.equal((await older).error?.code, 'stale_round');
        const current = await getRound(
          fixture.owner,
          fixture.roundId,
          new URLSearchParams(),
        );
        assert.equal(
          current.status,
          newerAction === 'reopen' ? 'RECORDING' : 'LOCKED',
        );
        assert.equal(current.version, winner.version);
        const bases = await inspect((client) =>
          client.query(
            'SELECT base_share_minor,remainder_units FROM expenses WHERE id=$1',
            [fixture.expenseId],
          ),
        );
        assert.deepEqual(
          bases.rows[0],
          newerAction === 'reopen'
            ? { base_share_minor: null, remainder_units: null }
            : { base_share_minor: '1', remainder_units: 1 },
        );
      } finally {
        resume();
        connectionMock.mock.restore();
        await older;
      }
    }
  },
);

test(
  '추첨이 회차 조회 이후 동시 결과와 멱등성 키를 재검사한다',
  { timeout: 15000 },
  async (t) => {
    for (const scenario of ['same-key', 'new-key', 'other-round']) {
      const fixture = await recordingRound();
      const confirm = await roundCommand(
        fixture.owner,
        key(),
        fixture.roundId,
        'confirm',
        { expectedVersion: fixture.version },
      );
      const locked = await roundCommand(
        fixture.owner,
        key(),
        fixture.roundId,
        'send',
        { expectedVersion: confirm.version },
      );
      const requestKey = key(),
        body = { expectedVersion: locked.version };
      let winnerRoundId = fixture.roundId,
        winnerVersion = locked.version;
      if (scenario === 'other-round') {
        const round = await createRound(
          fixture.owner,
          uuidV7(),
          fixture.groupId,
          {
            name: '같은 키 경합',
            participantIds: [fixture.owner.userId, fixture.participant.userId],
          },
        );
        const expense = await saveExpense(fixture.owner, key(), round.id, {
          currency: 'KRW',
          description: '다른 회차',
          amount: '3',
          payerId: fixture.owner.userId,
          splitMode: 'ALL',
          expectedVersion: round.version,
        });
        const confirmed = await roundCommand(
          fixture.owner,
          key(),
          round.id,
          'confirm',
          { expectedVersion: expense.version },
        );
        winnerRoundId = round.id;
        winnerVersion = (
          await roundCommand(fixture.owner, key(), round.id, 'send', {
            expectedVersion: confirmed.version,
          })
        ).version;
      }
      const pool = await getDatabasePool(process.env.DATABASE_URL!),
        connect = pool.connect.bind(pool);
      let resume!: () => void, reached!: () => void;
      const paused = new Promise<void>((resolve) => {
          reached = resolve;
        }),
        gate = new Promise<void>((resolve) => {
          resume = resolve;
        });
      const connectionMock = mockPoolConnection(t, pool, async () => {
        connectionMock.mock.restore();
        const borrowed = await connect();
        const queryMock = t.mock.method(
          borrowed,
          'query',
          new Proxy(borrowed.query, {
            apply(target, receiver, args) {
              return queryResult(args, (args) => {
                const pending = Reflect.apply(target, receiver, args);
                if (queryText(args[0]).includes("operation='round.draw'")) {
                  queryMock.mock.restore();
                  return pending.then(async (result: unknown) => {
                    reached();
                    await gate;
                    return result;
                  });
                }
                return pending;
              });
            },
          }),
        );
        return borrowed;
      });
      const older = roundCommand(
        fixture.owner,
        requestKey,
        fixture.roundId,
        'draw',
        body,
        () => assert.fail('losing draw must not publish'),
      ).then(
        (result) => ({ result, error: undefined }),
        (error) => ({ result: undefined, error }),
      );
      try {
        await paused;
        const winner = await roundCommand(
          fixture.owner,
          scenario === 'new-key' ? key() : requestKey,
          winnerRoundId,
          'draw',
          { expectedVersion: winnerVersion },
        );
        const saved = await getRound(
          fixture.owner,
          fixture.roundId,
          new URLSearchParams(),
        );
        resume();
        const outcome = await older;
        if (scenario === 'other-round')
          assert.equal(outcome.error?.code, 'idempotency_conflict');
        else assert.deepEqual(outcome.result, winner);
        assert.deepEqual(
          await getRound(fixture.owner, fixture.roundId, new URLSearchParams()),
          saved,
        );
      } finally {
        resume();
        connectionMock.mock.restore();
        await older;
      }
    }
  },
);

test('동시 수령 확인을 함께 반영하고 일반·강제 종료가 모두 커밋되지 않게 한다', async () => {
  const finalRound = async () => {
    const fixture = await recordingRound();
    const confirmed = await roundCommand(
      fixture.owner,
      key(),
      fixture.roundId,
      'confirm',
      { expectedVersion: fixture.version },
    );
    const locked = await roundCommand(
      fixture.owner,
      key(),
      fixture.roundId,
      'send',
      { expectedVersion: confirmed.version },
    );
    const finalized = await roundCommand(
      fixture.owner,
      key(),
      fixture.roundId,
      'draw',
      { expectedVersion: locked.version },
    );
    return { ...fixture, version: finalized.version! };
  };

  const simultaneous = await group();
  const third = await member();
  await acceptInvite(third, key(), simultaneous.token);
  const round = await createRound(
    simultaneous.owner,
    uuidV7(),
    simultaneous.groupId,
    {
      name: '복수 수취 경합',
      participantIds: [
        simultaneous.owner.userId,
        simultaneous.participant.userId,
        third.userId,
      ],
    },
  );
  const expense = await saveExpense(simultaneous.owner, key(), round.id, {
    currency: 'KRW',
    description: '복수 송금',
    amount: '6',
    payerId: simultaneous.owner.userId,
    splitMode: 'ALL',
    expectedVersion: round.version,
  });
  const confirmed = await roundCommand(
    simultaneous.owner,
    key(),
    round.id,
    'confirm',
    { expectedVersion: expense.version },
  );
  const locked = await roundCommand(
    simultaneous.owner,
    key(),
    round.id,
    'send',
    { expectedVersion: confirmed.version },
  );
  const incoming = (await getSettlement(simultaneous.owner, round.id)).incoming;
  assert.equal(incoming.length, 2);
  const checks = await Promise.all(
    incoming.map((transfer) =>
      setSettlementCheck(simultaneous.owner, key(), round.id, {
        expectedVersion: locked.version,
        checked: true,
        currency: 'KRW',
        senderId: transfer.senderId,
      }),
    ),
  );
  assert.ok(checks.every((result) => result.version === locked.version));
  const checked = await getSettlement(simultaneous.owner, round.id);
  assert.equal(checked.confirmations.length, 1);
  assert.ok(checked.incoming.every((transfer) => transfer.receivedAt !== null));
  const completions = await Promise.allSettled([
    roundCommand(simultaneous.owner, key(), round.id, 'complete', {
      expectedVersion: locked.version,
    }),
    roundCommand(simultaneous.owner, key(), round.id, 'force-complete', {
      expectedVersion: locked.version,
    }),
  ]);
  assert.equal(
    completions.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  assert.equal(
    (await getRound(simultaneous.owner, round.id, new URLSearchParams()))
      .version,
    locked.version! + 1,
  );

  const lastCheck = await finalRound();
  const race = await Promise.allSettled([
    setSettlementCheck(lastCheck.owner, key(), lastCheck.roundId, {
      expectedVersion: lastCheck.version,
      checked: true,
    }),
    roundCommand(lastCheck.owner, key(), lastCheck.roundId, 'complete', {
      expectedVersion: lastCheck.version,
    }),
  ]);
  assert.equal(race[0].status, 'fulfilled');
  const current = await getSettlement(lastCheck.owner, lastCheck.roundId);
  assert.equal(current.allChecked, true);
  if (current.status === 'LOCKED')
    await roundCommand(lastCheck.owner, key(), lastCheck.roundId, 'complete', {
      expectedVersion: current.version,
    });
});

test(
  '강제 종료가 미수령자 조회 이후 경쟁한 종료·재시도를 재검사한다',
  { timeout: 15000 },
  async (t) => {
    for (const winnerAction of ['same-key', 'new-key', 'complete']) {
      const fixture = await recordingRound();
      const confirmed = await roundCommand(
        fixture.owner,
        key(),
        fixture.roundId,
        'confirm',
        { expectedVersion: fixture.version },
      );
      const locked = await roundCommand(
        fixture.owner,
        key(),
        fixture.roundId,
        'send',
        { expectedVersion: confirmed.version },
      );
      const finalized = await roundCommand(
        fixture.owner,
        key(),
        fixture.roundId,
        'draw',
        { expectedVersion: locked.version },
      );
      if (winnerAction === 'complete')
        await setSettlementCheck(fixture.owner, key(), fixture.roundId, {
          expectedVersion: finalized.version,
          checked: true,
        });
      const requestKey = key(),
        body = { expectedVersion: finalized.version };
      const pool = await getDatabasePool(process.env.DATABASE_URL!),
        connect = pool.connect.bind(pool);
      let resume!: () => void, reached!: () => void;
      const paused = new Promise<void>((resolve) => {
          reached = resolve;
        }),
        gate = new Promise<void>((resolve) => {
          resume = resolve;
        });
      const connectionMock = mockPoolConnection(t, pool, async () => {
        connectionMock.mock.restore();
        const borrowed = await connect();
        const queryMock = t.mock.method(
          borrowed,
          'query',
          new Proxy(borrowed.query, {
            apply(target, receiver, args) {
              return queryResult(args, (args) => {
                const pending = Reflect.apply(target, receiver, args);
                if (queryText(args[0]).includes('AS pending_user_ids')) {
                  queryMock.mock.restore();
                  return pending.then(async (result: unknown) => {
                    reached();
                    await gate;
                    return result;
                  });
                }
                return pending;
              });
            },
          }),
        );
        return borrowed;
      });
      const older = roundCommand(
        fixture.owner,
        requestKey,
        fixture.roundId,
        'force-complete',
        body,
        () =>
          assert.fail('losing or replayed force completion must not publish'),
      ).then(
        (result) => ({ result, error: undefined }),
        (error) => ({ result: undefined, error }),
      );
      try {
        await paused;
        const winner = await roundCommand(
          fixture.owner,
          winnerAction === 'same-key' ? requestKey : key(),
          fixture.roundId,
          winnerAction === 'complete' ? 'complete' : 'force-complete',
          body,
        );
        const saved = await getSettlement(fixture.owner, fixture.roundId);
        resume();
        const outcome = await older;
        if (winnerAction === 'same-key')
          assert.deepEqual(outcome.result, winner);
        else assert.equal(outcome.error?.code, 'stale_round');
        assert.deepEqual(
          await getSettlement(fixture.owner, fixture.roundId),
          saved,
        );
        assert.equal(saved.version, finalized.version! + 1);
      } finally {
        resume();
        connectionMock.mock.restore();
        await older;
      }
    }
  },
);

test(
  '다른 회차의 동일 키 강제 종료 중 하나만 성공하고 실패 회차를 보존한다',
  { timeout: 15000 },
  async (t) => {
    const fixture = await group();
    const rounds = [];
    for (let index = 0; index < 2; index++) {
      const round = await createRound(
        fixture.owner,
        uuidV7(),
        fixture.groupId,
        {
          name: '강제 종료 멱등 경합',
          participantIds: [fixture.owner.userId, fixture.participant.userId],
        },
      );
      const expense = await saveExpense(fixture.owner, key(), round.id, {
        currency: 'KRW',
        description: '지출',
        amount: '4',
        payerId: fixture.owner.userId,
        splitMode: 'ALL',
        expectedVersion: round.version,
      });
      const confirmed = await roundCommand(
        fixture.owner,
        key(),
        round.id,
        'confirm',
        { expectedVersion: expense.version },
      );
      const locked = await roundCommand(
        fixture.owner,
        key(),
        round.id,
        'send',
        { expectedVersion: confirmed.version },
      );
      rounds.push({ id: round.id, version: locked.version! });
    }
    const pool = await getDatabasePool(process.env.DATABASE_URL!),
      connect = pool.connect.bind(pool);
    let releaseReads!: () => void,
      reads = 0;
    const bothRead = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    const connectionMock = mockPoolConnection(t, pool, async () => {
      const borrowed = await connect();
      const queryMock = t.mock.method(
        borrowed,
        'query',
        new Proxy(borrowed.query, {
          apply(target, receiver, args) {
            return queryResult(args, (args) => {
              const pending = Reflect.apply(target, receiver, args);
              if (queryText(args[0]).includes('AS pending_user_ids')) {
                queryMock.mock.restore();
                return pending.then(async (result: unknown) => {
                  if (++reads === 2) releaseReads();
                  await bothRead;
                  return result;
                });
              }
              return pending;
            });
          },
        }),
      );
      return borrowed;
    });
    const requestKey = key();
    try {
      const outcomes = await Promise.allSettled(
        rounds.map((round) =>
          roundCommand(fixture.owner, requestKey, round.id, 'force-complete', {
            expectedVersion: round.version,
          }),
        ),
      );
      assert.equal(
        outcomes.filter((result) => result.status === 'fulfilled').length,
        1,
      );
      for (let index = 0; index < outcomes.length; index++) {
        const outcome = outcomes[index],
          current = await getSettlement(fixture.owner, rounds[index].id);
        if (outcome.status === 'fulfilled')
          assert.equal(current.status, 'COMPLETED');
        else {
          assert.equal(outcome.reason.code, 'idempotency_conflict');
          assert.equal(current.status, 'LOCKED');
          assert.equal(current.version, rounds[index].version);
          assert.equal(
            (
              await getRound(
                fixture.owner,
                rounds[index].id,
                new URLSearchParams(),
              )
            ).completedAt,
            null,
          );
        }
        assert.ok(
          current.incoming.every((transfer) => transfer.receivedAt === null),
        );
      }
    } finally {
      releaseReads();
      connectionMock.mock.restore();
    }
  },
);

test(
  '수령 확인이 송금 조회 이후 중복 확인과 완료된 회차를 재검사한다',
  { timeout: 15000 },
  async (t) => {
    for (const winnerAction of ['check', 'force-complete']) {
      const fixture = await recordingRound();
      const confirmed = await roundCommand(
        fixture.owner,
        key(),
        fixture.roundId,
        'confirm',
        { expectedVersion: fixture.version },
      );
      const locked = await roundCommand(
        fixture.owner,
        key(),
        fixture.roundId,
        'send',
        { expectedVersion: confirmed.version },
      );
      const finalized = await roundCommand(
        fixture.owner,
        key(),
        fixture.roundId,
        'draw',
        { expectedVersion: locked.version },
      );
      const body = { expectedVersion: finalized.version, checked: true };
      const pool = await getDatabasePool(process.env.DATABASE_URL!),
        connect = pool.connect.bind(pool);
      let resume!: () => void, reached!: () => void;
      const paused = new Promise<void>((resolve) => {
          reached = resolve;
        }),
        gate = new Promise<void>((resolve) => {
          resume = resolve;
        });
      const connectionMock = mockPoolConnection(t, pool, async () => {
        connectionMock.mock.restore();
        const borrowed = await connect();
        const queryMock = t.mock.method(
          borrowed,
          'query',
          new Proxy(borrowed.query, {
            apply(target, receiver, args) {
              return queryResult(args, (args) => {
                const pending = Reflect.apply(target, receiver, args);
                if (queryText(args[0]).includes('AS incoming')) {
                  queryMock.mock.restore();
                  return pending.then(async (result: unknown) => {
                    reached();
                    await gate;
                    return result;
                  });
                }
                return pending;
              });
            },
          }),
        );
        return borrowed;
      });
      const older = setSettlementCheck(
        fixture.owner,
        key(),
        fixture.roundId,
        body,
        () => assert.fail('losing check must not publish'),
      ).then(
        (result) => ({ result, error: undefined }),
        (error) => ({ result: undefined, error }),
      );
      try {
        await paused;
        if (winnerAction === 'check')
          await setSettlementCheck(fixture.owner, key(), fixture.roundId, body);
        else
          await roundCommand(
            fixture.owner,
            key(),
            fixture.roundId,
            winnerAction,
            { expectedVersion: finalized.version },
          );
        const saved = await getSettlement(fixture.owner, fixture.roundId);
        resume();
        assert.equal((await older).error?.code, 'not_found');
        assert.deepEqual(
          await getSettlement(fixture.owner, fixture.roundId),
          saved,
        );
      } finally {
        resume();
        connectionMock.mock.restore();
        await older;
      }
    }
  },
);

test('회차 생성과 탈퇴가 경쟁해도 탈퇴 회원의 미완료 참여를 만들지 않는다', async () => {
  const fixture = await group();
  const outcomes = await Promise.allSettled([
    createRound(fixture.owner, uuidV7(), fixture.groupId, {
      name: '탈퇴와 경합',
      participantIds: [fixture.owner.userId, fixture.participant.userId],
    }),
    withdrawAccount(fixture.participant),
  ]);
  assert.equal(
    outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
    1,
  );
  const state = await inspect(
    async (client) =>
      (
        await client.query(
          `
    SELECT u.deleted_at,
      (SELECT COUNT(*)::int FROM round_members m JOIN rounds r ON r.id=m.round_id WHERE m.user_id=u.id AND r.status<>'COMPLETED') AS unfinished
    FROM users u WHERE u.id=$1`,
          [fixture.participant.userId],
        )
      ).rows[0],
  );
  if (outcomes[0].status === 'fulfilled') {
    assert.equal(state.deleted_at, null);
    assert.equal(state.unfinished, 1);
    assert.ok(
      outcomes[1].status === 'rejected' &&
        outcomes[1].reason instanceof AppError,
    );
    assert.equal(outcomes[1].reason.code, 'unfinished_rounds');
    await roundCommand(fixture.owner, key(), outcomes[0].value.id, 'cancel', {
      expectedVersion: 1,
    });
  } else {
    assert.ok(outcomes[0].reason instanceof AppError);
    assert.equal(outcomes[0].reason.code, 'invalid_participants');
    assert.notEqual(state.deleted_at, null);
    assert.equal(state.unfinished, 0);
  }
});

test('탈퇴가 회차 생성 락을 기다린 뒤 미완료 참여를 확인한다', async () => {
  const fixture = await group();
  const gate = createDatabaseClient(testUrl!);
  const roundId = key();
  let withdrawal: Promise<{ error?: unknown }> | undefined;
  let gateHeld = false;
  try {
    await gate.connect();
    await gate.query('BEGIN');
    gateHeld = true;
    await gate.query('SELECT pg_advisory_xact_lock(1684106607)::text');
    withdrawal = withdrawAccount(fixture.participant).then(
      () => ({}),
      (error) => ({ error }),
    );
    const deadline = Date.now() + 4000;
    while (true) {
      const waiting = await gate.query(
        `SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
        WHERE l.locktype='advisory' AND NOT l.granted AND a.application_name=$1`,
        [applicationName],
      );
      if (waiting.rowCount) break;
      assert.ok(
        Date.now() < deadline,
        'withdrawal did not reach its write-lock wait',
      );
      await sleep(20);
    }
    // Commit a new round while withdrawal waits: its unfinished check must run after the lock.
    const now = currentTimestamp();
    await gate.query(
      `INSERT INTO rounds(id,group_id,creator_id,name,status,version,created_at)
      VALUES($1,$2,$3,'락 대기 중 생성','RECORDING',1,$4)`,
      [roundId, fixture.groupId, fixture.owner.userId, now],
    );
    for (const actor of [fixture.owner, fixture.participant])
      await gate.query(
        `
      INSERT INTO round_members(round_id,user_id,display_name_snapshot,joined_at) VALUES($1,$2,'경합 검증',$3)`,
        [roundId, actor.userId, now],
      );
    await gate.query('COMMIT');
    gateHeld = false;
    const outcome = await withdrawal;
    assert.ok(outcome.error instanceof AppError);
    assert.equal(outcome.error.code, 'unfinished_rounds');
    assert.equal(
      (outcome.error.details as { rounds: { id: string }[] }).rounds[0].id,
      roundId,
    );
    const state = (
      await gate.query(
        `SELECT u.deleted_at,m.left_at FROM users u
      JOIN group_members m ON m.user_id=u.id WHERE u.id=$1 AND m.group_id=$2`,
        [fixture.participant.userId, fixture.groupId],
      )
    ).rows[0];
    assert.deepEqual(state, { deleted_at: null, left_at: null });
    await roundCommand(fixture.owner, key(), roundId, 'cancel', {
      expectedVersion: 1,
    });
  } finally {
    if (gateHeld) await gate.query('ROLLBACK');
    await withdrawal;
    await gate.end();
  }
});

test('회차 생성이 공통 락을 기다린 뒤 커밋된 모임 이탈·탈퇴 상태를 확인한다', async () => {
  for (const action of ['leave', 'close', 'withdraw', 'actor-withdraw']) {
    const fixture = await group(),
      gate = createDatabaseClient(testUrl!);
    let held = false;
    let creation: Promise<{ result?: unknown; error?: unknown }> | undefined;
    try {
      await gate.connect();
      await gate.query('BEGIN');
      held = true;
      await gate.query('SELECT pg_advisory_xact_lock(1684106607)::text');
      creation = createRound(fixture.owner, uuidV7(), fixture.groupId, {
        name: '락 대기 후 상태 확인',
        participantIds: [fixture.owner.userId, fixture.participant.userId],
      }).then(
        (result) => ({ result }),
        (error) => ({ error }),
      );
      const deadline = Date.now() + 4000;
      while (true) {
        const waiting = await gate.query(
          `SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
          WHERE l.locktype='advisory' AND NOT l.granted AND a.application_name=$1`,
          [applicationName],
        );
        if (waiting.rowCount) break;
        assert.ok(
          Date.now() < deadline,
          'creation did not wait for the common lock',
        );
        await sleep(20);
      }
      const actor =
        action === 'close' || action === 'actor-withdraw'
          ? fixture.owner
          : fixture.participant;
      const now = currentTimestamp();
      if (action.includes('withdraw'))
        await gate.query(
          'UPDATE users SET deleted_at=$2,updated_at=$2 WHERE id=$1',
          [actor.userId, now],
        );
      await gate.query(
        'UPDATE group_members SET left_at=$3 WHERE group_id=$1 AND ($4::boolean OR user_id=$2)',
        [fixture.groupId, actor.userId, now, action === 'close'],
      );
      await gate.query('COMMIT');
      held = false;
      const outcome = await creation;
      assert.ok(outcome.error instanceof AppError);
      assert.equal(
        outcome.error.code,
        action === 'actor-withdraw'
          ? 'unauthorized'
          : action === 'close'
            ? 'not_found'
            : 'invalid_participants',
      );
      assert.equal(
        (
          await gate.query(
            'SELECT count(*)::int AS count FROM rounds WHERE group_id=$1',
            [fixture.groupId],
          )
        ).rows[0].count,
        0,
      );
    } finally {
      if (held) await gate.query('ROLLBACK');
      await creation;
      await gate.end();
    }
  }
});

test('초대 수락과 탈퇴가 경쟁해도 탈퇴 회원의 활성 멤버십을 남기지 않는다', async () => {
  const fixture = await group(false);
  const outcomes = await Promise.allSettled([
    acceptInvite(fixture.participant, key(), fixture.token),
    withdrawAccount(fixture.participant),
  ]);
  assert.equal(outcomes[1].status, 'fulfilled');
  if (outcomes[0].status === 'rejected') {
    assert.ok(outcomes[0].reason instanceof AppError);
    assert.equal(outcomes[0].reason.code, 'unauthorized');
  }
  const state = await inspect(
    async (client) =>
      (
        await client.query(
          `
    SELECT u.deleted_at,
      (SELECT COUNT(*)::int FROM group_members m WHERE m.user_id=u.id AND m.left_at IS NULL) AS memberships
    FROM users u WHERE u.id=$1`,
          [fixture.participant.userId],
        )
      ).rows[0],
  );
  assert.notEqual(state.deleted_at, null);
  assert.equal(state.memberships, 0);
});

test('동시 초대 수락이 모임의 활성 회원 정원 10명을 초과하지 않는다', async () => {
  const fixture = await group(false);
  const existing: AccessToken[] = [];
  for (let index = 0; index < 8; index++) existing.push(await member());
  for (const person of existing)
    await acceptInvite(person, key(), fixture.token);
  const candidates = [fixture.participant, await member()];
  const outcomes = await Promise.allSettled(
    candidates.map((person) => acceptInvite(person, key(), fixture.token)),
  );
  assert.equal(
    outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
    1,
  );
  const failure = outcomes.find(
    (outcome) => outcome.status === 'rejected',
  ) as PromiseRejectedResult;
  assert.ok(failure.reason instanceof AppError);
  assert.equal(failure.reason.code, 'group_member_limit_exceeded');
  const winner =
    candidates[
      outcomes.findIndex((outcome) => outcome.status === 'fulfilled')
    ]!;
  const loser =
    candidates[outcomes.findIndex((outcome) => outcome.status === 'rejected')]!;
  await assert.rejects(
    acceptInvite(winner, key(), fixture.token),
    (error) =>
      error instanceof AppError && error.code === 'group_already_member',
  );
  await leaveGroup(winner, key(), fixture.groupId);
  await acceptInvite(loser, key(), fixture.token);
  await assert.rejects(
    acceptInvite(winner, key(), fixture.token),
    (error) =>
      error instanceof AppError && error.code === 'group_member_limit_exceeded',
  );
  const counts = await inspect(
    async (client) =>
      (
        await client.query(
          `SELECT
    COUNT(*) FILTER (WHERE left_at IS NULL)::int AS total,
    COUNT(*) FILTER (WHERE left_at IS NULL AND user_id=ANY($2::text[]))::int AS accepted_candidates
    FROM group_members WHERE group_id=$1`,
          [fixture.groupId, candidates.map((person) => person.userId)],
        )
      ).rows[0],
  );
  assert.equal(counts.total, 10);
  assert.equal(counts.accepted_candidates, 1);
});

test('영수증 저장이 조건부 수정 대기 후 동시에 잠긴 회차를 거부한다', async () => {
  const fixture = await recordingRound();
  const gate = createDatabaseClient(testUrl!);
  const requestKey = key();
  let upload: Promise<{ result?: unknown; error?: unknown }> | undefined;
  let gateHeld = false;
  try {
    await gate.connect();
    await gate.query('BEGIN');
    gateHeld = true;
    await gate.query('SELECT id FROM rounds WHERE id=$1 FOR UPDATE', [
      fixture.roundId,
    ]);
    upload = addReceipt(
      fixture.participant,
      requestKey,
      fixture.roundId,
      fixture.expenseId,
      fixture.version,
      avif,
      'image/avif',
    ).then(
      (result) => ({ result }),
      (error) => ({ error }),
    );

    // Observe the actual pending PostgreSQL lock, proving parsing completed before the state change.
    const deadline = Date.now() + 4000;
    while (true) {
      await gate.query('SELECT pg_stat_clear_snapshot()');
      const waiting = await gate.query(
        `SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
        WHERE l.locktype='transactionid' AND NOT l.granted AND a.application_name=$1`,
        [applicationName],
      );
      if (waiting.rowCount) break;
      assert.ok(
        Date.now() < deadline,
        'upload did not reach its PostgreSQL write-lock wait',
      );
      await sleep(20);
    }
    const now = currentTimestamp();
    // The competing transaction confirms and sends this valid 3 / 2 round while the upload waits.
    await gate.query(
      'UPDATE expenses SET base_share_minor=1,remainder_units=1 WHERE round_id=$1',
      [fixture.roundId],
    );
    await gate.query(
      "UPDATE rounds SET status='CONFIRMED',confirmed_at=$2,version=version+1 WHERE id=$1 AND status='RECORDING'",
      [fixture.roundId, now],
    );
    await gate.query(
      "UPDATE rounds SET status='LOCKED',locked_at=$2,version=version+1 WHERE id=$1 AND status='CONFIRMED'",
      [fixture.roundId, now],
    );
    await gate.query('COMMIT');
    gateHeld = false;

    const outcome = await upload;
    assert.ok(outcome.error instanceof AppError);
    assert.equal(outcome.error.code, 'stale_round');
    const persisted = await gate.query(
      `SELECT
      (SELECT COUNT(*)::int FROM expense_receipts WHERE expense_id=$1) AS receipts,
      (SELECT COUNT(*)::int FROM mutation_requests WHERE request_key=$2) AS successful_requests`,
      [fixture.expenseId, requestKey],
    );
    assert.deepEqual(persisted.rows[0], {
      receipts: 0,
      successful_requests: 0,
    });
    const current = await getRound(
      fixture.owner,
      fixture.roundId,
      new URLSearchParams(),
    );
    assert.equal(current.status, 'LOCKED');
    assert.equal(current.version, fixture.version + 2);
    assert.equal(current.expenses[0].amountMinor, '3');
    const drawn = await roundCommand(
      fixture.owner,
      key(),
      fixture.roundId,
      'draw',
      { expectedVersion: current.version },
    );
    await roundCommand(
      fixture.owner,
      key(),
      fixture.roundId,
      'force-complete',
      { expectedVersion: drawn.version },
    );
  } finally {
    if (gateHeld) await gate.query('ROLLBACK').catch(() => {});
    if (upload) await upload;
    await gate.end();
  }
});

test(
  '지출 삭제가 락 획득 전 조회 이후 상태와 중복 삭제 재시도를 재검사한다',
  { timeout: 15000 },
  async (t) => {
    for (const action of ['confirm', 'same-key', 'different-key'] as const) {
      const fixture = await recordingRound(),
        requestKey = key(),
        body = { expectedVersion: fixture.version };
      const pool = await getDatabasePool(process.env.DATABASE_URL!),
        connect = pool.connect.bind(pool);
      let resume!: () => void, reached!: () => void;
      const paused = new Promise<void>((resolve) => {
          reached = resolve;
        }),
        gate = new Promise<void>((resolve) => {
          resume = resolve;
        });
      const connectionMock = mockPoolConnection(t, pool, async () => {
        connectionMock.mock.restore();
        const borrowed = await connect();
        const queryMock = t.mock.method(
          borrowed,
          'query',
          new Proxy(borrowed.query, {
            apply(target, receiver, args) {
              return queryResult(args, (args) => {
                const pending = Reflect.apply(target, receiver, args);
                if (queryText(args[0]).includes('LEFT JOIN expenses')) {
                  queryMock.mock.restore();
                  return pending.then(async (result: unknown) => {
                    reached();
                    await gate;
                    return result;
                  });
                }
                return pending;
              });
            },
          }),
        );
        return borrowed;
      });
      const older = deleteExpense(
        fixture.participant,
        requestKey,
        fixture.roundId,
        fixture.expenseId,
        body,
        () => assert.fail('losing or replayed deletion must not publish'),
      ).then(
        (result) => ({ result, error: undefined }),
        (error) => ({ result: undefined, error }),
      );
      try {
        await paused;
        const winner =
          action === 'confirm'
            ? await roundCommand(
                fixture.owner,
                key(),
                fixture.roundId,
                'confirm',
                body,
              )
            : await deleteExpense(
                fixture.participant,
                action === 'same-key' ? requestKey : key(),
                fixture.roundId,
                fixture.expenseId,
                body,
              );
        resume();
        const outcome = await older;
        if (action === 'same-key') assert.deepEqual(outcome.result, winner);
        else
          assert.equal(
            outcome.error?.code,
            action === 'confirm' ? 'invalid_round_state' : 'not_found',
          );
        const current = await getRound(
          fixture.owner,
          fixture.roundId,
          new URLSearchParams(),
        );
        assert.equal(current.version, winner.version);
        assert.equal(current.expenses.length, action === 'confirm' ? 1 : 0);
        assert.equal(
          (
            await inspect((client) =>
              client.query(
                "SELECT 1 FROM mutation_requests WHERE actor_id=$1 AND operation='expense.delete' AND request_key=$2",
                [fixture.participant.userId, requestKey],
              ),
            )
          ).rowCount,
          action === 'same-key' ? 1 : 0,
        );
      } finally {
        resume();
        connectionMock.mock.restore();
        await older;
      }
    }
  },
);

// Pause after the old-version read, before the shared lock, so PATCH wins deterministically.
test(
  '지출 수정이 이미 조회한 쓰기 상태와 실패한 조건부 수정을 재검사한다',
  { timeout: 15000 },
  async (t) => {
    for (const action of ['confirm', 'delete', 'patch'] as const) {
      const fixture = await recordingRound();
      const pool = await getDatabasePool(process.env.DATABASE_URL!);
      const connect = pool.connect.bind(pool);
      let resume!: () => void,
        reached!: () => void,
        restoreQuery: (() => void) | undefined;
      let held = false;
      const statements: string[] = [];
      const paused = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const connectionMock = mockPoolConnection(t, pool, async () => {
        connectionMock.mock.restore();
        const borrowed = await connect();
        const queryMock = t.mock.method(
          borrowed,
          'query',
          new Proxy(borrowed.query, {
            apply(target, receiver, args) {
              return queryResult(args, (args) => {
                const pending = Reflect.apply(target, receiver, args);
                const sql = queryText(args[0]);
                statements.push(sql);
                if (
                  !held &&
                  (action === 'patch' || action === 'delete'
                    ? sql.includes('LEFT JOIN expenses')
                    : sql.includes("operation='round.confirm'"))
                ) {
                  held = true;
                  if (action !== 'patch') queryMock.mock.restore();
                  return pending.then(async (result: unknown) => {
                    reached();
                    await gate;
                    return result;
                  });
                }
                return pending;
              });
            },
          }),
        );
        restoreQuery = () => queryMock.mock.restore();
        return borrowed;
      });
      const olderKey = key();
      const older = (
        action === 'confirm'
          ? roundCommand(fixture.owner, olderKey, fixture.roundId, 'confirm', {
              expectedVersion: fixture.version,
            })
          : action === 'delete'
            ? deleteExpense(
                fixture.owner,
                olderKey,
                fixture.roundId,
                fixture.expenseId,
                { expectedVersion: fixture.version },
              )
            : saveExpense(
                fixture.owner,
                olderKey,
                fixture.roundId,
                {
                  description: '오래된 수정',
                  expectedVersion: fixture.version,
                },
                fixture.expenseId,
              )
      ).then(
        () => ({ error: undefined }),
        (error) => ({ error }),
      );
      try {
        await paused;
        const edited = await saveExpense(
          fixture.participant,
          key(),
          fixture.roundId,
          {
            description: '먼저 저장한 수정',
            amount: '4',
            expectedVersion: fixture.version,
          },
          fixture.expenseId,
        );
        resume();
        assert.equal((await older).error?.code, 'stale_round', action);
        restoreQuery?.();
        if (action === 'patch') {
          assert.equal(statements.length, 7);
          assert.equal(statements[2], 'BEGIN');
          assert.equal(
            statements[3],
            'SELECT pg_advisory_xact_lock(1684106607)::text',
          );
          assert.match(statements[4], /UPDATE rounds.*version=\$13/s);
          assert.match(statements[5], /LEFT JOIN expenses/);
          assert.equal(statements[6], 'ROLLBACK');
        }
        const current = await getRound(
          fixture.owner,
          fixture.roundId,
          new URLSearchParams(),
        );
        assert.equal(current.status, 'RECORDING');
        assert.equal(current.version, edited.version);
        assert.equal(current.expenses.length, 1);
        assert.equal(current.expenses[0].description, '먼저 저장한 수정');
        assert.equal(current.totals[0]?.totalMinor, '4');
        assert.ok(
          current.expenses[0].shares.every(
            (share) => share.amountMinor === null,
          ),
        );
        assert.equal(
          (
            await inspect((client) =>
              client.query(
                'SELECT 1 FROM mutation_requests WHERE request_key=$1',
                [olderKey],
              ),
            )
          ).rowCount,
          0,
        );
      } finally {
        resume();
        connectionMock.mock.restore();
        await older;
        restoreQuery?.();
      }
    }
  },
);

test(
  '확인이 커밋까지 공통 락을 유지하고 지출 생성·수정·재시도를 대기시킨다',
  { timeout: 15000 },
  async (t) => {
    const fixture = await recordingRound();
    const pool = await getDatabasePool(process.env.DATABASE_URL!);
    const connect = pool.connect.bind(pool);
    let resume!: () => void, reached!: () => void;
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const connectionMock = mockPoolConnection(t, pool, async () => {
      connectionMock.mock.restore();
      const borrowed = await connect();
      const queryMock = t.mock.method(
        borrowed,
        'query',
        new Proxy(borrowed.query, {
          apply(target, receiver, args) {
            return queryResult(args, (args) => {
              const pending = Reflect.apply(target, receiver, args);
              if (
                queryText(args[0]) ===
                'SELECT pg_advisory_xact_lock(1684106607)::text'
              ) {
                queryMock.mock.restore();
                return pending.then(async (result: unknown) => {
                  reached();
                  await gate;
                  return result;
                });
              }
              return pending;
            });
          },
        }),
      );
      return borrowed;
    });
    const requestKey = key(),
      body = { expectedVersion: fixture.version };
    const confirming = roundCommand(
      fixture.owner,
      requestKey,
      fixture.roundId,
      'confirm',
      body,
    );
    let competing: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      await paused;
      competing = Promise.allSettled([
        saveExpense(fixture.owner, key(), fixture.roundId, {
          currency: 'KRW',
          description: '대기 중 추가',
          amount: '5',
          payerId: fixture.owner.userId,
          splitMode: 'ALL',
          ...body,
        }),
        saveExpense(
          fixture.participant,
          key(),
          fixture.roundId,
          { description: '대기 중 수정', ...body },
          fixture.expenseId,
        ),
        roundCommand(
          fixture.owner,
          requestKey,
          fixture.roundId,
          'confirm',
          body,
        ),
      ]);
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const locks = await inspect((client) =>
          client.query(
            `SELECT count(*)::int AS count FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
        WHERE l.locktype='advisory' AND NOT l.granted AND a.application_name=$1`,
            [applicationName],
          ),
        );
        if (locks.rows[0].count === 3) {
          waiting = true;
          break;
        }
        await sleep(20);
      }
      assert.ok(
        waiting,
        'create, PATCH and same-key confirm must all wait for the confirmation lock',
      );
      const beforeCommit = await getRound(
        fixture.owner,
        fixture.roundId,
        new URLSearchParams(),
      );
      assert.equal(beforeCommit.status, 'RECORDING');
      assert.equal(beforeCommit.version, fixture.version);
      resume();
      const confirmed = await confirming,
        outcomes = await competing;
      for (const outcome of outcomes.slice(0, 2)) {
        assert.equal(outcome.status, 'rejected');
        assert.equal(
          (outcome as PromiseRejectedResult).reason.code,
          'invalid_round_state',
        );
      }
      assert.deepEqual(outcomes[2], { status: 'fulfilled', value: confirmed });
      const current = await getRound(
        fixture.owner,
        fixture.roundId,
        new URLSearchParams(),
      );
      assert.equal(current.status, 'CONFIRMED');
      assert.equal(current.version, fixture.version + 1);
      assert.equal(current.expenses.length, 1);
      assert.equal(current.expenses[0].description, '경합 지출');
      assert.equal(current.expenses[0].baseShareMinor, '1');
      assert.equal(current.expenses[0].remainderUnits, 1);
    } finally {
      resume();
      connectionMock.mock.restore();
      await Promise.allSettled([confirming, competing]);
    }
  },
);

before(async () => {
  await getPrismaClient(process.env.TEST_DATABASE_URL!);
});
