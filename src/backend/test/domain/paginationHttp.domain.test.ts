import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  createMockBackend,
  mockFetch,
  mockOrigin,
} from '../support/mockHttpTestSupport';
import { createDatabaseClient } from '../../global/database/db';
import {
  createAccessToken,
  readAccessToken,
} from '../support/legacyTokenTestSupport.ts';
import { GroupService } from '../../domain/group/service/group.service';
import { SettleService } from '../../domain/settle/service/settle.service';
import { applyMigrations } from '../../../../scripts/migrations.mjs';
import { uuidV7 } from '../../../shared/uuid';
import { completeTestOnboarding } from '../support/bankTestSupport';
import {
  signInKakao,
  createGroup,
  createInvite,
  acceptInvite,
  createRound,
} from '../support/domainTestSupport';

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
process.env.AUTH_JWT_SECRET ||= 'isolated-pagination-secret-at-least-32-bytes';

test('actual Nest pagination passes typed queries once and preserves cursor, search, authorization and SQL contracts', async (t) => {
  const db = createDatabaseClient(database);
  await db.connect();
  try {
    await applyMigrations(db);
  } finally {
    await db.end();
  }
  const member = async () => {
    const session = await signInKakao(`pagination-http:${randomUUID()}`, {
      displayName: '페이지 검증',
      email: null,
      profileImageUrl: null,
    });
    return completeTestOnboarding(readAccessToken(session.accessToken), {
      bankName: '검증 은행',
      accountNumber: '12340312345678',
      accountHolder: '페이지 검증',
    });
  };
  const ownerSession = await member(),
    guestSession = await member();
  const owner = readAccessToken(ownerSession.accessToken)!,
    guest = readAccessToken(guestSession.accessToken)!;
  const search = `페이지${randomUUID()}`;
  const groups = await Promise.all(
    [0, 1].map((i) =>
      createGroup(owner, uuidV7(), { name: `${search} 모임${i}` }),
    ),
  );
  const invite = await createInvite(owner, randomUUID(), groups[0].id, {});
  await acceptInvite(guest, randomUUID(), invite.sharePath!.split('/').at(-1)!);
  const rounds = [];
  for (let i = 0; i < 2; i++)
    rounds.push(
      await createRound(owner, uuidV7(), groups[0].id, {
        name: `${search} 회차${i}`,
        participantIds: [owner.userId, guest.userId],
      }),
    );
  const { app } = await createMockBackend();
  const previousLog = process.env.DB_QUERY_LOG;
  t.after(async () => {
    await app.close();
    if (previousLog === undefined) delete process.env.DB_QUERY_LOG;
    else process.env.DB_QUERY_LOG = previousLog;
  });

  const origin = mockOrigin(app);
  let calls = 0;
  const groupService = app.get(GroupService),
    settleService = app.get(SettleService);
  const listGroups = groupService.listGroups.bind(groupService);
  const listRounds = settleService.listRounds.bind(settleService);
  const getRound = settleService.getRound.bind(settleService);
  t.mock.method(
    groupService,
    'listGroups',
    (...args: Parameters<typeof listGroups>) => {
      calls++;
      assert.equal(args[1].search, search);
      assert.equal(typeof args[1].limit, 'number');
      assert.ok(!(args[1] instanceof URLSearchParams));
      return listGroups(...args);
    },
  );
  t.mock.method(
    settleService,
    'listRounds',
    (...args: Parameters<typeof listRounds>) => {
      calls++;
      assert.equal(args[1].search, search);
      assert.equal(args[1].status, 'active');
      if (args[1].cursor)
        assert.equal(typeof args[1].cursor.createdAt, 'string');
      return listRounds(...args);
    },
  );
  t.mock.method(
    settleService,
    'getRound',
    (...args: Parameters<typeof getRound>) => {
      calls++;
      assert.deepEqual(args[2], { limit: 1, cursor: null });
      return getRound(...args);
    },
  );
  process.env.DB_QUERY_LOG = 'true';
  let statements: string[] = [];
  t.mock.method(console, 'info', (message: string) => {
    if (message.startsWith('SQL:'))
      statements.push(message.replace(/\s+/g, ' '));
  });
  const request = async (
    path: string,
    count: number,
    status = 200,
    token: string | null = ownerSession.accessToken,
  ) => {
    statements = [];
    const response = await mockFetch(app)(`${origin}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(10000),
    });
    const payload = await response.json();
    assert.equal(
      response.status,
      status,
      `${path}: ${JSON.stringify(payload)}`,
    );
    assert.equal(statements.length, count, statements.join('\n'));
    assert.ok(
      statements.every(
        (sql) => !/\bBEGIN\b|\bCOMMIT\b|pg_advisory|FOR UPDATE/.test(sql),
      ),
    );
    if (count) assert.match(statements[0], /"users" WHERE .*"id" = \$1/);
    return payload;
  };
  const query = new URLSearchParams({ limit: '1', q: ` ${search} ` });
  const firstGroup = (await request(`/api/groups?${query}`, 3)).data;
  query.set('cursor', firstGroup.nextCursor);
  const secondGroup = (await request(`/api/groups?${query}`, 3)).data;
  assert.equal(secondGroup.nextCursor, null);
  assert.deepEqual(
    new Set(
      [...firstGroup.items, ...secondGroup.items].map(
        (item: { id: string }) => item.id,
      ),
    ),
    new Set(groups.map((group) => group.id)),
  );
  for (const path of ['/api/rounds', `/api/groups/${groups[0].id}/rounds`]) {
    const query = new URLSearchParams({
      limit: '1',
      q: ` ${search} `,
      status: 'active',
    });
    const first = (await request(`${path}?${query}`, 2)).data;
    query.set('cursor', first.nextCursor);
    const second = (await request(`${path}?${query}`, 2)).data;
    assert.equal(second.nextCursor, null);
    assert.deepEqual(
      new Set(
        [...first.items, ...second.items].map(
          (item: { id: string }) => item.id,
        ),
      ),
      new Set(rounds.map((round) => round.id)),
    );
  }
  await request(`/api/rounds/${rounds[0].id}?limit=1`, 2);
  const successfulCalls = calls;
  const invalidCursor = Buffer.from(
    JSON.stringify({ id: 'entry', createdAt: '9007199254740992' }),
  ).toString('base64url');
  for (const path of [
    '/api/groups',
    '/api/rounds',
    `/api/groups/${groups[0].id}/rounds`,
    `/api/rounds/${rounds[0].id}`,
  ]) {
    for (const input of [
      'limit=0',
      'limit=101',
      'limit=1.5',
      'limit=2&limit=3',
      'cursor=invalid',
      `cursor=${invalidCursor}`,
      'extra=1',
    ]) {
      const payload = await request(`${path}?${input}`, 0, 400);
      assert.equal(
        payload.code,
        input.startsWith('cursor=') ? 'invalid_cursor' : 'invalid_input',
      );
      if (input.startsWith('cursor=')) {
        assert.equal(payload.message, '목록을 다시 불러와 주세요');
        assert.equal(payload.detail, null);
      }
      await request(`${path}?${input}`, 0, 401, null);
      await request(`${path}?${input}`, 0, 401, 'tampered');
    }
    await request(`${path}?cursor=${'a'.repeat(513)}`, 0, 400);
  }
  for (const path of [
    '/api/groups',
    '/api/rounds',
    `/api/groups/${groups[0].id}/rounds`,
  ])
    for (const query of ['q=', 'q=%20%20', 'q=' + 'x'.repeat(101)])
      await request(`${path}?${query}`, 0, 400);
  await request('/api/rounds?status=INVALID', 0, 400);
  assert.equal(
    calls,
    successfulCalls,
    'malformed queries and invalid JWTs never reach a Service',
  );
  // Valid typed input still performs the account lookup before any resource SQL.
  const missingAccount = createAccessToken(randomUUID(), randomUUID());
  await request(`/api/rounds/${rounds[0].id}?limit=1`, 1, 401, missingAccount);
});
