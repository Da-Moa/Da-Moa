import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { RealtimePublisher } from '../../global/util/invalidationUtil';
const publications = new RealtimePublisher();
const registerInvalidationPublisher =
  publications.registerInvalidationPublisher.bind(publications);
const realtimeEnabled = publications.realtimeEnabled.bind(publications);
const publishInvalidations =
  publications.publishInvalidations.bind(publications);
const publishGroupInvalidation =
  publications.publishGroupInvalidation.bind(publications);
const publishRoundInvalidation =
  publications.publishRoundInvalidation.bind(publications);
const publishBankInvalidation =
  publications.publishBankInvalidation.bind(publications);
const publishDepartureInvalidation =
  publications.publishDepartureInvalidation.bind(publications);

function publisher(t: TestContext) {
  const messages: { userId: string; keys: string[] }[] = [];
  const publish = t.mock.fn((userId: string, keys: string[]) => {
    messages.push({ userId, keys });
  });
  const unregister = registerInvalidationPublisher(publish);
  const fetch = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Invalidation must not issue HTTP requests');
  });
  t.after(() => {
    unregister();
    assert.equal(fetch.mock.callCount(), 0);
  });
  return { messages, publish, unregister };
}

test('모임 변경 알림이 목록·상세 범위를 유지하고 수신자 없는 변경을 생략한다', async (t) => {
  const { messages } = publisher(t);
  await publishGroupInvalidation('group-1', ['owner', 'member']);
  await publishGroupInvalidation('group-1', ['owner'], true);
  await publishGroupInvalidation('group-1');
  assert.deepEqual(messages, [
    { userId: 'owner', keys: ['groups', 'group:group-1'] },
    { userId: 'member', keys: ['groups', 'group:group-1'] },
    { userId: 'owner', keys: ['group:group-1'] },
  ]);
});

test('회차 변경 알림이 참여자에게만 전달되고 정산 전용 범위·재시도 알림 생략을 유지한다', async (t) => {
  const { messages } = publisher(t);
  const audience = {
    groupId: 'group-1',
    userIds: ['participant'],
    groupUserIds: ['outsider'],
  };
  await publishRoundInvalidation('round-1', audience);
  await publishRoundInvalidation('round-1', audience, true);
  await publishRoundInvalidation('round-1', null);
  await publishRoundInvalidation('round-1', {
    groupId: 'group-1',
    userIds: [],
  });
  assert.deepEqual(messages, [
    {
      userId: 'participant',
      keys: [
        'rounds',
        'group-rounds:group-1',
        'round:round-1',
        'settlement:round-1',
      ],
    },
    { userId: 'participant', keys: ['settlement:round-1'] },
  ]);
});

test('사용자별 중복 재조회 키를 합치고 다른 수신자에게 키를 노출하지 않는다', async (t) => {
  const { messages } = publisher(t);
  await publishInvalidations([
    {
      userIds: ['owner', 'owner', 'member'],
      keys: ['groups', 'group:group-1'],
    },
    { userIds: ['owner'], keys: ['groups', 'me'] },
  ]);
  await publishInvalidations([]);
  assert.deepEqual(messages, [
    { userId: 'owner', keys: ['groups', 'group:group-1', 'me'] },
    { userId: 'member', keys: ['groups', 'group:group-1'] },
  ]);
});

test('계좌 변경 알림이 본인 정보와 영향받는 송금자의 정산만 갱신한다', async (t) => {
  const { messages } = publisher(t);
  await publishBankInvalidation('owner', async (userId) => {
    assert.equal(userId, 'owner');
    assert.deepEqual(messages, [{ userId: 'owner', keys: ['me'] }]);
    return [
      { sender_id: 'sender', round_id: 'round-1' },
      { sender_id: 'sender', round_id: 'round-1' },
      { sender_id: 'sender', round_id: 'round-2' },
      { sender_id: 'other', round_id: 'round-2' },
    ];
  });
  assert.deepEqual(messages, [
    { userId: 'owner', keys: ['me'] },
    {
      userId: 'sender',
      keys: ['settlement:round-1', 'settlement:round-2'],
    },
    { userId: 'other', keys: ['settlement:round-2'] },
  ]);
});

test('계좌 알림 수신자 조회 실패 시 이미 보낸 본인 갱신 알림을 유지한다', async (t) => {
  const { messages } = publisher(t);
  const errors = t.mock.method(console, 'error', () => {});
  await publishBankInvalidation('owner', async () => {
    throw new Error('lookup failed');
  });
  assert.deepEqual(messages, [{ userId: 'owner', keys: ['me'] }]);
  assert.deepEqual(
    errors.mock.calls.map((call) => call.arguments),
    [['Realtime bank invalidation failed']],
  );
});

test('탈퇴 알림을 각 모임의 남은 회원에게 전달하고 중복 수신자를 합친다', async (t) => {
  const { messages } = publisher(t);
  let lookups = 0;
  const getMembers = async (groupIds: string[]) => {
    lookups++;
    assert.deepEqual(groupIds, ['group-1', 'group-2']);
    return [
      { group_id: 'group-1', user_id: 'member' },
      { group_id: 'group-2', user_id: 'member' },
      { group_id: 'group-2', user_id: 'other' },
      { group_id: 'unrelated', user_id: 'outsider' },
    ];
  };
  await publishDepartureInvalidation(['group-1', 'group-2'], getMembers);
  await publishDepartureInvalidation([], getMembers);
  assert.equal(lookups, 1);
  assert.deepEqual(messages, [
    {
      userId: 'member',
      keys: ['groups', 'group:group-1', 'group:group-2'],
    },
    { userId: 'other', keys: ['groups', 'group:group-2'] },
  ]);
});

test('실시간 전송이 등록되지 않으면 알림·수신자 조회를 실행하지 않는다', async (t) => {
  const { messages, unregister } = publisher(t);
  assert.equal(realtimeEnabled(), true);
  unregister();
  assert.equal(realtimeEnabled(), false);
  let lookups = 0;
  const getRecipients = async () => {
    lookups++;
    return [];
  };
  await publishInvalidations([{ userIds: ['owner'], keys: ['me'] }]);
  await publishBankInvalidation('owner', getRecipients);
  await publishDepartureInvalidation(['group-1'], getRecipients);
  assert.equal(lookups, 0);
  assert.deepEqual(messages, []);
});

test('전송·탈퇴 수신자 조회 실패를 처리하고 예외 상세를 노출하지 않는다', async (t) => {
  const { publish } = publisher(t);
  const errors = t.mock.method(console, 'error', () => {});
  publish.mock.mockImplementationOnce(() => {
    throw new Error('send failed');
  });
  await publishGroupInvalidation('group-1', ['member']);
  publish.mock.mockImplementationOnce(() => {
    throw new Error('private transport details');
  });
  await publishBankInvalidation('owner', async () => [
    { sender_id: 'sender', round_id: 'round-1' },
  ]);
  assert.equal(
    publish.mock.callCount(),
    3,
    'settlement publication still runs after owner publication fails',
  );
  await publishDepartureInvalidation(['group-1'], async () => {
    throw new Error('private DB details');
  });
  assert.deepEqual(
    errors.mock.calls.map((call) => call.arguments),
    [
      ['Realtime invalidation failed'],
      ['Realtime invalidation failed'],
      ['Realtime departure invalidation failed'],
    ],
  );
});

test('이전 전송자 등록을 해제해도 새 전송자를 비활성화하지 않는다', async (t) => {
  const { publish: first, unregister: stopFirst } = publisher(t);
  const second = t.mock.fn((userId: string, keys: string[]) => {});
  const stopSecond = registerInvalidationPublisher(second);
  t.after(stopSecond);
  stopFirst();
  assert.equal(realtimeEnabled(), true);
  await publishGroupInvalidation('group-1', ['member']);
  assert.equal(first.mock.callCount(), 0);
  assert.deepEqual(
    second.mock.calls.map((call) => call.arguments),
    [['member', ['groups', 'group:group-1']]],
  );
  stopSecond();
  assert.equal(realtimeEnabled(), false);
});
