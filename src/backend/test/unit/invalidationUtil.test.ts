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

test('group invalidation preserves list/detail scope and skips missing mutation audiences', async (t) => {
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

test('round invalidation targets participants, preserves settlement-only scope and skips replay audiences', async (t) => {
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

test('publications merge duplicate keys per user without leaking keys to other recipients', async (t) => {
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

test('bank invalidation refreshes the owner before lookup and only affected settlement senders afterwards', async (t) => {
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

test('bank recipient lookup failure preserves the already-published owner refresh', async (t) => {
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

test('departure invalidation maps each group to its remaining members and merges shared recipients', async (t) => {
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

test('unregistered realtime performs no publication or recipient lookup', async (t) => {
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

test('transport and departure lookup failures are contained without exposing exception details', async (t) => {
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

test('closing an older registration cannot disable a newer publisher', async (t) => {
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
