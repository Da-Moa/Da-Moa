import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {
  publishInvalidations,
  publishGroupInvalidation,
  publishRoundInvalidation,
  publishBankInvalidation,
  publishDepartureInvalidation,
  realtimeEnabled,
} from '../../global/util/invalidationUtil';

function publisher(t: TestContext) {
  const previousPort = process.env.REALTIME_INTERNAL_PORT;
  const previousSecret = process.env.REALTIME_INTERNAL_SECRET;
  process.env.REALTIME_INTERNAL_PORT = '12345';
  process.env.REALTIME_INTERNAL_SECRET = 'invalidation-unit-test';
  t.after(() => {
    if (previousPort === undefined) delete process.env.REALTIME_INTERNAL_PORT;
    else process.env.REALTIME_INTERNAL_PORT = previousPort;
    if (previousSecret === undefined)
      delete process.env.REALTIME_INTERNAL_SECRET;
    else process.env.REALTIME_INTERNAL_SECRET = previousSecret;
  });
  const messages: { userId: string; keys: string[] }[][] = [];
  const fetch = t.mock.method(
    globalThis,
    'fetch',
    async (url: unknown, init?: RequestInit) => {
      assert.equal(url, 'http://127.0.0.1:12345/internal/realtime');
      assert.equal(init?.method, 'POST');
      assert.deepEqual(init?.headers, {
        authorization: 'Bearer invalidation-unit-test',
        'content-type': 'application/json',
      });
      assert.ok(init?.signal instanceof AbortSignal);
      messages.push(JSON.parse(init?.body as string));
      return new Response(null, { status: 204 });
    },
  );
  return { messages, fetch };
}

test('group invalidation preserves list/detail scope and skips missing mutation audiences', async (t) => {
  const { messages } = publisher(t);
  await publishGroupInvalidation('group-1', ['owner', 'member']);
  await publishGroupInvalidation('group-1', ['owner'], true);
  await publishGroupInvalidation('group-1');
  assert.deepEqual(messages, [
    [
      { userId: 'owner', keys: ['groups', 'group:group-1'] },
      { userId: 'member', keys: ['groups', 'group:group-1'] },
    ],
    [{ userId: 'owner', keys: ['group:group-1'] }],
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
    [
      {
        userId: 'participant',
        keys: [
          'rounds',
          'group-rounds:group-1',
          'round:round-1',
          'settlement:round-1',
        ],
      },
    ],
    [{ userId: 'participant', keys: ['settlement:round-1'] }],
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
    [
      { userId: 'owner', keys: ['groups', 'group:group-1', 'me'] },
      { userId: 'member', keys: ['groups', 'group:group-1'] },
    ],
  ]);
});

test('bank invalidation refreshes the owner before lookup and only affected settlement senders afterwards', async (t) => {
  const { messages } = publisher(t);
  await publishBankInvalidation('owner', async (userId) => {
    assert.equal(userId, 'owner');
    assert.deepEqual(messages, [[{ userId: 'owner', keys: ['me'] }]]);
    return [
      { sender_id: 'sender', round_id: 'round-1' },
      { sender_id: 'sender', round_id: 'round-1' },
      { sender_id: 'sender', round_id: 'round-2' },
      { sender_id: 'other', round_id: 'round-2' },
    ];
  });
  assert.deepEqual(messages, [
    [{ userId: 'owner', keys: ['me'] }],
    [
      { userId: 'sender', keys: ['settlement:round-1', 'settlement:round-2'] },
      { userId: 'other', keys: ['settlement:round-2'] },
    ],
  ]);
});

test('bank recipient lookup failure preserves the already-published owner refresh', async (t) => {
  const { messages } = publisher(t);
  const errors = t.mock.method(console, 'error', () => {});
  await publishBankInvalidation('owner', async () => {
    throw new Error('lookup failed');
  });
  assert.deepEqual(messages, [[{ userId: 'owner', keys: ['me'] }]]);
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
    [
      { userId: 'member', keys: ['groups', 'group:group-1', 'group:group-2'] },
      { userId: 'other', keys: ['groups', 'group:group-2'] },
    ],
  ]);
});

test('disabled realtime performs no publication or recipient lookup', async (t) => {
  const { messages } = publisher(t);
  let lookups = 0;
  const getRecipients = async () => {
    lookups++;
    return [];
  };
  for (const missing of [
    'REALTIME_INTERNAL_PORT',
    'REALTIME_INTERNAL_SECRET',
  ]) {
    const previous = process.env[missing];
    delete process.env[missing];
    assert.equal(realtimeEnabled(), false);
    await publishInvalidations([{ userIds: ['owner'], keys: ['me'] }]);
    await publishBankInvalidation('owner', getRecipients);
    await publishDepartureInvalidation(['group-1'], getRecipients);
    process.env[missing] = previous;
  }
  assert.equal(realtimeEnabled(), true);
  assert.equal(lookups, 0);
  assert.deepEqual(messages, []);
});

test('transport and departure lookup failures are contained without exposing exception details', async (t) => {
  const { fetch } = publisher(t);
  const errors = t.mock.method(console, 'error', () => {});
  fetch.mock.mockImplementationOnce(
    async () => new Response(null, { status: 503 }),
  );
  await publishGroupInvalidation('group-1', ['member']);
  fetch.mock.mockImplementationOnce(async () => {
    throw new Error('private transport details');
  });
  await publishBankInvalidation('owner', async () => [
    { sender_id: 'sender', round_id: 'round-1' },
  ]);
  assert.equal(
    fetch.mock.callCount(),
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
