import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Server } from 'node:net';
import { ScenarioUser } from '../support/scenarioTestSupport';
import {
  testApplication,
  signInKakao,
  completeOnboarding,
} from '../support/domainTestSupport';
import { readAccessToken } from '../support/legacyTokenTestSupport';
import { RealtimePublisher } from '../../global/util/invalidationUtil';
import { createDatabaseClient } from '../../global/database/db';
import { applyMigrations } from '../../../../scripts/migrations.mjs';
import { uuidV7 } from '../../../shared/uuid';

const database = process.env.TEST_DATABASE_URL;
if (
  !database ||
  !['localhost', '127.0.0.1', '[::1]'].includes(new URL(database).hostname) ||
  !new URL(database).pathname.includes('test')
)
  throw new Error('An isolated local TEST_DATABASE_URL is required');
process.env.DATABASE_URL = database;

test('커밋된 모의 요청이 응답 완료 후 알림을 보내고 모임·회차·계좌·탈퇴 수신자를 격리한다', async (t) => {
  t.mock.method(Server.prototype, 'listen', () => {
    throw new Error('Integration tests must not listen');
  });
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Integration tests must not send HTTP');
  });
  const db = createDatabaseClient(database);
  await db.connect();
  t.after(() => db.end());
  await applyMigrations(db);
  const app = await testApplication();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < 4; i++) {
    const session = await signInKakao(`notifications:${randomUUID()}`, {
      displayName: '알림 검증',
      email: null,
      profileImageUrl: null,
    });
    const onboarded = await completeOnboarding(
      readAccessToken(session.accessToken),
      {
        bankCode: '004',
        accountNumber: '12340312345678',
        accountHolder: '알림 검증',
        expectedBankVersion: 0,
      },
    );
    const user = new ScenarioUser(app);
    user.id = onboarded.userId;
    user.accessToken = onboarded.accessToken;
    users.push(user);
  }
  const [owner, participant, spectator, outsider] = users;
  const group = await owner.createGroup();
  await outsider.createGroup('다른 모임');
  const invite = await owner.data(`groups/${group.id}/invites`, 'POST', {});
  for (const user of [participant, spectator])
    await user.data(
      `invites/${invite.sharePath.split('/').at(-1)}/accept`,
      'POST',
    );
  const delivered: { userId: string; keys: string[] }[] = [];
  const stop = app
    .get(RealtimePublisher)
    .registerInvalidationPublisher((userId, keys) =>
      delivered.push({ userId, keys }),
    );
  t.after(stop);
  const key = uuidV7();
  const created = await owner.send(
    `groups/${group.id}/rounds`,
    'POST',
    { name: '알림 회차', participantIds: [owner.id, participant.id] },
    200,
    key,
  );
  const round = (await created.json()).data;
  const roundKeys = [
    'rounds',
    `group-rounds:${group.id}`,
    `round:${round.id}`,
    `settlement:${round.id}`,
  ];
  const messages = (ids: (string | undefined)[], keys: string[]) =>
    ids
      .map((userId) => ({ userId, keys }))
      .sort((a, b) => a.userId!.localeCompare(b.userId!));
  assert.deepEqual(
    created.notifications
      .slice()
      .sort((a, b) => a.userId.localeCompare(b.userId)),
    messages([owner.id, participant.id], roundKeys),
  );
  assert.deepEqual(delivered, created.notifications);
  const failed = await owner.send(
    `groups/${group.id}/rounds`,
    'POST',
    { name: '중복', participantIds: [owner.id, participant.id] },
    409,
    key,
  );
  assert.deepEqual(failed.notifications, []);
  const expense = await owner.data(`rounds/${round.id}/expenses`, 'POST', {
    description: '알림 식비',
    amount: '8000',
    currency: 'KRW',
    payerId: owner.id,
    splitMode: 'ALL',
    expectedVersion: round.version,
  });
  const confirmed = await owner.data(`rounds/${round.id}/confirm`, 'POST', {
    expectedVersion: expense.version,
  });
  await owner.data(`rounds/${round.id}/send`, 'POST', {
    expectedVersion: confirmed.version,
  });
  const me = await owner.data('me');
  const bank = await owner.send('me/bank-account', 'PUT', {
    bankCode: '004',
    accountNumber: '12340312345679',
    accountHolder: '변경된 계좌',
    expectedBankVersion: me.bankVersion,
  });
  assert.deepEqual(
    bank.notifications,
    [
      { userId: owner.id, keys: ['me'] },
      { userId: participant.id, keys: [`settlement:${round.id}`] },
    ],
    'recipient DB lookups finish before the helper returns',
  );
  const stale = await owner.send(
    'me/bank-account',
    'PUT',
    {
      bankCode: '004',
      accountNumber: '12340312345678',
      accountHolder: '이전 계좌',
      expectedBankVersion: me.bankVersion,
    },
    409,
  );
  assert.deepEqual(stale.notifications, []);
  const withdrawn = await spectator.send('auth/withdraw', 'POST');
  assert.deepEqual(
    withdrawn.notifications
      .slice()
      .sort((a, b) => a.userId.localeCompare(b.userId)),
    messages([owner.id, participant.id], ['groups', `group:${group.id}`]),
  );
  assert.ok(
    delivered.every(
      (value) => value.userId !== outsider.id && value.userId !== spectator.id,
    ),
  );
});
