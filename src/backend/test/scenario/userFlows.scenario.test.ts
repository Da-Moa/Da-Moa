import assert from 'node:assert/strict';
import test, { before, after, mock } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Server } from 'node:net';
import { createMockBackend, mockOrigin } from '../support/mockHttpTestSupport';
import { ScenarioUser } from '../support/scenarioTestSupport';
import { KakaoOidcClient } from '../../global/auth/service/kakaoOidc.client';
import { createDatabaseClient } from '../../global/database/db';
import { applyMigrations } from '../../../../scripts/migrations.mjs';

const database = process.env.TEST_DATABASE_URL;
if (
  !database ||
  !['localhost', '127.0.0.1', '[::1]'].includes(new URL(database).hostname) ||
  !new URL(database).pathname.includes('test')
)
  throw new Error('An isolated local TEST_DATABASE_URL is required');
process.env.DATABASE_URL = database;
process.env.AUTH_JWT_SECRET = 'scenario-test-only-at-least-32-bytes';
process.env.KAKAO_REST_API_KEY = 'scenario-client';
Object.assign(process.env, { NODE_ENV: 'production' });
let backend: Awaited<ReturnType<typeof createMockBackend>>;

before(async () => {
  mock.method(Server.prototype, 'listen', () => {
    throw new Error('Scenario tests must not listen');
  });
  mock.method(globalThis, 'fetch', async () => {
    throw new Error('Scenario tests must not send HTTP');
  });
  const db = createDatabaseClient(database);
  await db.connect();
  try {
    await applyMigrations(db);
  } finally {
    await db.end();
  }
  backend = await createMockBackend(async (app) => {
    process.env.KAKAO_REDIRECT_URI = `${mockOrigin(app)}/auth/v1/kakao`;
    const oidc = app.get(KakaoOidcClient);
    mock.method(
      oidc,
      'authenticate',
      async (
        ...[_config, code, state, cookies]: Parameters<
          KakaoOidcClient['authenticate']
        >
      ) => {
        if (state !== cookies.state) return null;
        return {
          accessToken: 'mock-provider-token',
          subject: `scenario:${code}`,
        };
      },
    );
    mock.method(oidc, 'profile', async () => ({
      displayName: '흐름 사용자',
      email: null,
      profileImageUrl: null,
    }));
  });
});
after(async () => {
  await backend?.app.close();
  mock.restoreAll();
});

async function member() {
  const user = new ScenarioUser(backend.app);
  const code = randomUUID();
  assert.equal((await user.login(code)).purpose, 'onboarding');
  await user.onboard();
  assert.equal((await user.data('me')).purpose, 'app');
  return { user, code };
}
async function roundFixture(count = 2) {
  const users: ScenarioUser[] = [];
  for (let i = 0; i < count; i++) users.push((await member()).user);
  const owner = users[0],
    group = await owner.createGroup();
  const invite = await owner.data(`groups/${group.id}/invites`, 'POST', {});
  const token = invite.sharePath.split('/').at(-1);
  for (const user of users.slice(1))
    await user.data(`invites/${token}/accept`, 'POST');
  const round = await owner.createRound(group.id, users);
  return { users, owner, group, round };
}

// Each scenario carries real response cookies, JWTs, IDs and versions forward.
test('초대 → 로그인 → 가입 → 수락 → 토큰 갱신 → 로그아웃에서 목적지와 멤버십을 유지한다', async () => {
  const { user: owner } = await member();
  const group = await owner.createGroup();
  const invite = await owner.data(`groups/${group.id}/invites`, 'POST', {});
  const token = invite.sharePath.split('/').at(-1),
    destination = `/invites/${token}`;
  const guest = new ScenarioUser(backend.app);
  await guest.login(randomUUID(), destination);
  assert.equal(
    (await guest.data('groups', 'GET', undefined, 403)).code,
    'onboarding_required',
  );
  assert.equal((await guest.onboard()).returnTo, destination);
  assert.equal((await guest.data(`invites/${token}`)).groupId, group.id);
  const key = randomUUID();
  assert.equal(
    (await guest.data(`invites/${token}/accept`, 'POST', undefined, 200, key))
      .id,
    group.id,
  );
  assert.equal(
    (await guest.data(`invites/${token}/accept`, 'POST', undefined, 200, key))
      .id,
    group.id,
  );
  assert.equal(
    (await guest.data(`invites/${token}/accept`, 'POST', undefined, 409)).code,
    'group_already_member',
  );
  assert.equal((await owner.data(`groups/${group.id}`)).members.length, 2);
  const refreshed = await guest.data('auth/refresh', 'POST');
  guest.accessToken = refreshed.accessToken;
  assert.equal((await guest.data(`groups/${group.id}`)).id, group.id);
  await owner.data(`groups/${group.id}/invites/${invite.id}`, 'DELETE');
  assert.equal(
    (await guest.data(`invites/${token}`, 'GET', undefined, 404)).code,
    'not_found',
  );
  await guest.data('auth/logout', 'POST');
  guest.accessToken = undefined;
  assert.equal(guest.cookies.has('da_moa_refresh'), false);
  assert.equal(
    (await guest.data('me', 'GET', undefined, 401)).code,
    'unauthorized',
  );
});

test('모임 → 회차 → 지출 → 확인 → 정산 전송 → 수령 확인 → 종료 후 모임 이탈·탈퇴를 허용한다', async () => {
  const { owner, users, group, round } = await roundFixture();
  const expenseKey = randomUUID();
  const body = {
    description: '식비',
    currency: 'KRW',
    amount: '10000',
    payerId: owner.id,
    splitMode: 'ALL',
    expectedVersion: round.version,
  };
  const expense = await owner.data(
    `rounds/${round.id}/expenses`,
    'POST',
    body,
    200,
    expenseKey,
  );
  assert.deepEqual(
    await owner.data(
      `rounds/${round.id}/expenses`,
      'POST',
      body,
      200,
      expenseKey,
    ),
    expense,
  );
  assert.equal(
    (
      await owner.data(
        `rounds/${round.id}/expenses`,
        'POST',
        { ...body, amount: '20000' },
        409,
        expenseKey,
      )
    ).code,
    'idempotency_conflict',
  );
  assert.equal(
    (await users[1].data(`groups/${group.id}`, 'DELETE', undefined, 409)).code,
    'unfinished_rounds',
  );
  assert.equal(
    (await users[1].data('auth/withdraw', 'POST', undefined, 409)).code,
    'unfinished_rounds',
  );
  let version = expense.version;
  version = (
    await owner.data(`rounds/${round.id}/confirm`, 'POST', {
      expectedVersion: version,
    })
  ).version;
  assert.equal(
    (
      await users[1].data(
        `rounds/${round.id}/send`,
        'POST',
        { expectedVersion: version },
        403,
      )
    ).code,
    'forbidden',
  );
  await owner.data(`rounds/${round.id}/send`, 'POST', {
    expectedVersion: version,
  });
  const settlement = await owner.data(`rounds/${round.id}/settlement`);
  assert.equal(settlement.finalized, true);
  assert.equal(settlement.incoming[0].amountMinor, '5000');
  assert.equal(
    (
      await owner.data(
        `rounds/${round.id}/complete`,
        'POST',
        { expectedVersion: settlement.version },
        409,
      )
    ).code,
    'pending_settlement_checks',
  );
  const incoming = settlement.incoming[0];
  await owner.data(`rounds/${round.id}/settlement-check`, 'POST', {
    checked: true,
    senderId: incoming.senderId,
    currency: incoming.currency,
    expectedVersion: settlement.version,
  });
  const checked = await owner.data(`rounds/${round.id}/settlement`);
  assert.equal(checked.allChecked, true);
  await owner.data(`rounds/${round.id}/complete`, 'POST', {
    expectedVersion: checked.version,
  });
  assert.equal(
    (await users[1].data(`rounds/${round.id}/settlement`)).status,
    'COMPLETED',
  );
  assert.equal(
    (
      await owner.data(
        `rounds/${round.id}/expenses/${expense.id}`,
        'PATCH',
        { amount: '20000', expectedVersion: checked.version },
        409,
      )
    ).code,
    'invalid_round_state',
  );
  await users[1].data(`groups/${group.id}`, 'DELETE');
  assert.equal(
    (await users[1].data(`rounds/${round.id}/settlement`)).status,
    'COMPLETED',
  );
  await users[1].data('auth/withdraw', 'POST');
  assert.equal(
    (await users[1].data('me', 'GET', undefined, 401)).code,
    'unauthorized',
  );
});

test('확인 → 다시 열기 → 수정 → 정산 전송 → 나머지 추첨 → 강제 종료에서 잔액을 정확히 유지한다', async () => {
  const { owner, users, round } = await roundFixture(3);
  let expense = await owner.data(`rounds/${round.id}/expenses`, 'POST', {
    description: '나머지 식비',
    amount: '10000',
    currency: 'KRW',
    payerId: owner.id,
    splitMode: 'ALL',
    expectedVersion: round.version,
  });
  let version = (
    await owner.data(`rounds/${round.id}/confirm`, 'POST', {
      expectedVersion: expense.version,
    })
  ).version;
  version = (
    await owner.data(`rounds/${round.id}/reopen`, 'POST', {
      expectedVersion: version,
    })
  ).version;
  assert.equal(
    (
      await owner.data(
        `rounds/${round.id}/expenses/${expense.id}`,
        'PATCH',
        { description: '오래된 수정', expectedVersion: expense.version },
        409,
      )
    ).code,
    'stale_round',
  );
  expense = await owner.data(
    `rounds/${round.id}/expenses/${expense.id}`,
    'PATCH',
    { description: '수정된 식비', expectedVersion: version },
  );
  version = (
    await owner.data(`rounds/${round.id}/confirm`, 'POST', {
      expectedVersion: expense.version,
    })
  ).version;
  await owner.data(`rounds/${round.id}/send`, 'POST', {
    expectedVersion: version,
  });
  const pending = await owner.data(`rounds/${round.id}/settlement`);
  assert.equal(pending.finalized, false);
  assert.equal(
    (
      await users[1].data(
        `rounds/${round.id}/draw`,
        'POST',
        { expectedVersion: pending.version },
        403,
      )
    ).code,
    'forbidden',
  );
  const key = randomUUID(),
    drawn = await owner.data(
      `rounds/${round.id}/draw`,
      'POST',
      { expectedVersion: pending.version },
      200,
      key,
    );
  assert.deepEqual(
    await owner.data(
      `rounds/${round.id}/draw`,
      'POST',
      { expectedVersion: pending.version },
      200,
      key,
    ),
    drawn,
  );
  assert.deepEqual(
    await owner.data(`rounds/${round.id}/draw`, 'POST', {
      expectedVersion: drawn.version,
    }),
    drawn,
  );
  const results = await Promise.all(
    users.map((user) => user.data(`rounds/${round.id}/settlement`)),
  );
  assert.equal(
    results.reduce(
      (sum, value) => sum + BigInt(value.balances[0].balanceMinor),
      0n,
    ),
    0n,
  );
  await owner.data(`rounds/${round.id}/force-complete`, 'POST', {
    expectedVersion: drawn.version,
  });
  assert.equal(
    (await owner.data(`rounds/${round.id}/settlement`)).status,
    'COMPLETED',
  );
});

test('빈 회차 취소 → 탈퇴 → 명시적 재가입에서 사용자 ID를 유지하고 이전 모임을 복구하지 않는다', async () => {
  const { user: owner, code } = await member(),
    guest = (await member()).user;
  const group = await owner.createGroup();
  const invite = await owner.data(`groups/${group.id}/invites`, 'POST', {});
  await guest.data(
    `invites/${invite.sharePath.split('/').at(-1)}/accept`,
    'POST',
  );
  const round = await owner.createRound(group.id, [owner, guest]);
  await owner.data(`rounds/${round.id}`, 'DELETE', {
    expectedVersion: round.version,
  });
  assert.equal(
    (await owner.data(`rounds/${round.id}`, 'GET', undefined, 404)).code,
    'not_found',
  );
  const previousId = owner.id;
  await owner.data('auth/withdraw', 'POST');
  owner.accessToken = undefined;
  assert.equal((await owner.login(code)).id, previousId);
  const me = await owner.data('me');
  assert.equal(
    (
      await owner.data(
        'me/onboarding',
        'POST',
        {
          bankCode: '004',
          accountNumber: '12340312345678',
          accountHolder: '시나리오 사용자',
          expectedBankVersion: me.bankVersion,
        },
        400,
      )
    ).code,
    'rejoin_confirmation_required',
  );
  await owner.onboard(true);
  assert.equal(owner.id, previousId);
  assert.equal(
    (await owner.data(`groups/${group.id}`, 'GET', undefined, 404)).code,
    'not_found',
  );
});
