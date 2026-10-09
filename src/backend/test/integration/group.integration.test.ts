import { mockPoolConnection, queryText } from '../support/dbTestSupport.ts';
import { before } from 'node:test';
import { getPrismaClient } from '../support/domainTestSupport.ts';
import { uuidV7 } from '../../../shared/uuid.ts';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  createAccessToken,
  readAccessToken,
} from '../support/legacyTokenTestSupport.ts';
import { signInKakao } from '../support/domainTestSupport.ts';
import { createDatabaseClient } from '../../global/database/db.ts';
import { withDatabaseConnection } from '../support/domainTestSupport.ts';
import { getDatabasePool } from '../support/domainTestSupport.ts';
import {
  acceptInvite,
  createGroup,
  createInvite,
  getGroup,
  getInvite,
  leaveGroup,
  listGroups,
  revokeInvite,
} from '../support/domainTestSupport.ts';
import { applyMigrations } from '../../../../scripts/migrations.mjs';
import { completeTestOnboarding } from './bankTestSupport.ts';
import {
  createRound,
  getRound,
  roundCommand,
} from '../support/domainTestSupport.ts';
import { RealtimePublisher } from '../../global/util/invalidationUtil.ts';
import { testProvider } from '../support/domainTestSupport.ts';
import { createBackend } from '../../domain/main';
import { GroupService } from '../../domain/group/service/group.service';
import {
  CreateGroupRequestDTO,
  CreateInviteRequestDTO,
} from '../../domain/group/dto/req/group.request.dto';

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
process.env.AUTH_JWT_SECRET ||= 'isolated-group-test-secret-at-least-32-bytes';

test('Group autocommit reads, group/invite creation/revocation and atomic replay/replacement; departure uses 2/3 business queries', async (t) => {
  const client = createDatabaseClient(database);
  await client.connect();
  try {
    await applyMigrations(client);
    const member = async (name: string) => {
      const onboarding = await signInKakao(`group-test:${randomUUID()}`, {
        displayName: name,
        email: null,
        profileImageUrl: null,
      });
      return readAccessToken(
        (
          await completeTestOnboarding(
            readAccessToken(onboarding.accessToken),
            {
              bankName: '테스트 은행',
              accountNumber: '12340312345678',
              accountHolder: name,
            },
          )
        ).accessToken,
      )!;
    };
    const owner = await member('모임 생성자'),
      participant = await member('모임 참여자'),
      outsider = await member('외부인');
    const previous = process.env.DB_QUERY_LOG;
    process.env.DB_QUERY_LOG = 'true';
    let statements: string[] = [];
    const logger = t.mock.method(console, 'info', (message: string) => {
      statements.push(
        message
          .replace(/^SQL:\s*/, '')
          .replace(/\s+/g, ' ')
          .trim(),
      );
    });
    const trace = async <T>(
      expected: number,
      write: boolean | 'session' | null,
      work: () => Promise<T>,
    ) => {
      statements = [];
      const result = await work();
      assert.equal(
        statements.length,
        expected + (write === 'session' ? 1 : 0),
        statements.join('\n'),
      );
      if (write === null) {
        assert.ok(
          statements.every(
            (sql) =>
              !/^(BEGIN|COMMIT|ROLLBACK|SET)\b/.test(sql) &&
              !/pg_advisory_xact_lock|FOR UPDATE|FOR SHARE/.test(sql),
          ),
        );
      } else if (write === 'session') {
        assert.equal(statements[2], 'BEGIN');
        assert.equal(
          statements[3],
          'SELECT pg_advisory_xact_lock(1684106607)::text',
        );
        assert.ok(['COMMIT', 'ROLLBACK'].includes(statements.at(-1)!));
        assert.ok(
          !statements.some((sql) => sql.includes('pg_advisory_unlock')),
        );
      } else {
        assert.equal(
          statements[0],
          write ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
        );
        assert.equal(statements.at(-1), 'COMMIT');
        assert.equal(
          statements.some((sql) => sql.includes('pg_advisory_xact_lock')),
          write,
        );
      }
      return result;
    };
    try {
      await t.test(
        'native Body DTOs own Group field validation and normalization; HTTP writes preserve replay, errors and SQL counts',
        async (ht) => {
          const { app } = await createBackend();
          ht.after(async () => app.close());
          await app.listen(0, '127.0.0.1');
          const origin = await app.getUrl(),
            service = app.get(GroupService);
          const accessToken = createAccessToken(owner.userId, owner.sessionId);
          const create = service.createGroup.bind(service),
            invite = service.createInvite.bind(service);
          let calls = 0;
          ht.mock.method(
            service,
            'createGroup',
            (...args: Parameters<typeof create>) => {
              calls++;
              assert.ok(args[2] instanceof CreateGroupRequestDTO);
              assert.equal(args[2].name, args[2].name.trim());
              return create(...args);
            },
          );
          ht.mock.method(
            service,
            'createInvite',
            (...args: Parameters<typeof invite>) => {
              calls++;
              assert.ok(args[3] instanceof CreateInviteRequestDTO);
              return invite(...args);
            },
          );
          const request = async (
            path: string,
            body: unknown,
            key: string,
            status: number,
            count: number,
            headers: Record<string, string> = {},
          ) => {
            statements = [];
            const response = await fetch(`${origin}${path}`, {
              method: 'POST',
              headers: {
                origin,
                authorization: `Bearer ${accessToken}`,
                'content-type': 'application/json',
                'idempotency-key': key,
                ...headers,
              },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(10000),
            });
            const result = await response.json();
            assert.equal(response.status, status, JSON.stringify(result));
            assert.equal(statements.length, count, statements.join('\n'));
            assert.ok(
              statements.every(
                (sql) =>
                  !/^(BEGIN|COMMIT|ROLLBACK|SET)\b|pg_advisory|FOR UPDATE/.test(
                    sql,
                  ),
              ),
            );
            if (count)
              assert.match(statements[0], /"users" WHERE .*"id" = \$1/);
            return result;
          };
          const ticket = uuidV7(),
            name = `네이티브 모임 ${randomUUID()}`;
          const created = await request(
            '/api/groups',
            { name: ` \t${name}\n ` },
            ticket,
            200,
            2,
          );
          assert.equal(created.data.id, ticket);
          ht.after(async () => {
            await leaveGroup(owner, randomUUID(), ticket);
          });
          assert.equal((await getGroup(owner, ticket)).name, name);
          assert.equal(
            (await request('/api/groups', { name: '중복' }, ticket, 409, 2))
              .code,
            'group_already_exists',
          );
          const validCalls = calls;
          for (const body of [
            {},
            { name: 123 },
            { name: null },
            { name: '   ' },
            { name: 'x'.repeat(101) },
            { name: '정상', extra: true },
            [],
          ])
            assert.equal(
              (await request('/api/groups', body, uuidV7(), 400, 0)).code,
              'invalid_input',
            );
          const fieldError = await request(
            '/api/groups',
            { name: 123 },
            uuidV7(),
            400,
            0,
          );
          assert.equal(fieldError.message, '입력값을 확인해 주세요');
          assert.deepEqual(fieldError.detail, { field: 'name' });
          assert.equal(
            (
              await request('/api/groups', {}, uuidV7(), 401, 0, {
                authorization: '',
              })
            ).code,
            'unauthorized',
          );
          assert.equal(
            (
              await request('/api/groups', {}, uuidV7(), 403, 0, {
                origin: 'https://evil.test',
              })
            ).code,
            'forbidden',
          );
          assert.equal(
            calls,
            validCalls,
            'rejected DTOs and Guards never call the Service',
          );
          const path = `/api/groups/${ticket}/invites`,
            inviteKey = randomUUID();
          const issued = (await request(path, {}, inviteKey, 200, 3)).data;
          const replay = (await request(path, {}, inviteKey, 200, 2)).data;
          assert.equal(replay.id, issued.id);
          assert.equal(replay.linkUnavailable, true);
          assert.equal(replay.sharePath, undefined);
          assert.equal(
            (
              await request(
                path,
                { replaceInviteId: issued.id },
                inviteKey,
                409,
                2,
              )
            ).code,
            'idempotency_conflict',
          );
          // A padded ID remains a different lookup value; validation never silently
          // changes the mutation digest or revokes a different invite.
          assert.equal(
            (
              await request(
                path,
                { replaceInviteId: ` ${issued.id} ` },
                randomUUID(),
                404,
                3,
              )
            ).code,
            'not_found',
          );
          const inviteCalls = calls;
          for (const body of [
            { replaceInviteId: '' },
            { replaceInviteId: '   ' },
            { replaceInviteId: null },
            { replaceInviteId: 123 },
            { replaceInviteId: 'x'.repeat(129) },
            { extra: true },
          ])
            assert.equal(
              (await request(path, body, randomUUID(), 400, 0)).code,
              'invalid_input',
            );
          assert.equal(calls, inviteCalls);
          const replaced = (
            await request(
              path,
              { replaceInviteId: issued.id },
              randomUUID(),
              200,
              3,
            )
          ).data;
          assert.notEqual(replaced.id, issued.id);
          assert.deepEqual(
            (await getGroup(owner, ticket)).invites.map((item) => item.id),
            [replaced.id],
          );
        },
      );
      const createKey = uuidV7(),
        body = { name: `모임 SQL ${randomUUID()}` };
      const group = await trace(2, null, () =>
        createGroup(owner, createKey, body),
      );
      assert.equal(group.id, createKey);
      for (const name of [body.name, '다른 이름']) {
        statements = [];
        await assert.rejects(
          createGroup(owner, createKey, { name }),
          (error: { code: string }) => error.code === 'group_already_exists',
        );
        assert.equal(statements.length, 2);
        assert.ok(
          statements.every(
            (sql) =>
              !/^(BEGIN|COMMIT|ROLLBACK|SET)\b/.test(sql) &&
              !sql.includes('mutation_requests') &&
              !sql.includes('pg_advisory_xact_lock'),
          ),
        );
      }
      assert.equal(
        (
          await client.query(
            'SELECT 1 FROM mutation_requests WHERE request_key=$1',
            [createKey],
          )
        ).rowCount,
        0,
      );
      const concurrentKey = uuidV7();
      const concurrent = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          createGroup(owner, concurrentKey, body),
        ),
      );
      assert.equal(
        concurrent.filter((result) => result.status === 'fulfilled').length,
        1,
      );
      assert.ok(
        concurrent
          .filter((result) => result.status === 'rejected')
          .every((result) => result.reason.code === 'group_already_exists'),
      );
      assert.equal(
        (
          await client.query(
            'SELECT COUNT(*)::int AS count FROM group_members WHERE group_id=$1',
            [concurrentKey],
          )
        ).rows[0].count,
        1,
      );
      await leaveGroup(owner, randomUUID(), concurrentKey);
      const rejectedKey = uuidV7(),
        constraint = `group_create_test_${randomUUID().replaceAll('-', '')}`;
      await client.query(
        `ALTER TABLE group_members ADD CONSTRAINT ${constraint} CHECK (group_id <> '${rejectedKey}') NOT VALID`,
      );
      try {
        await assert.rejects(
          createGroup(owner, rejectedKey, body),
          (error: { code: string; constraint: string }) =>
            error.code === '23514' && error.constraint === constraint,
        );
        assert.equal(
          (
            await client.query('SELECT 1 FROM groups WHERE id=$1', [
              rejectedKey,
            ])
          ).rowCount,
          0,
          'membership failure rolls back the group INSERT in the same statement',
        );
      } finally {
        await client.query(
          `ALTER TABLE group_members DROP CONSTRAINT ${constraint}`,
        );
      }
      const list = await trace(3, null, () =>
        listGroups(owner, new URLSearchParams({ q: body.name })),
      );
      assert.equal(list.items.length, 1);
      assert.equal(list.items[0].memberCount, 1);
      const ownerDetail = await trace(3, null, () => getGroup(owner, group.id));
      assert.deepEqual(ownerDetail, {
        id: group.id,
        name: body.name,
        creatorId: owner.userId,
        createdAt: ownerDetail.createdAt,
        isCreator: true,
        members: [
          {
            userId: owner.userId,
            displayName: '모임 생성자',
            excludedAt: null,
          },
        ],
        invites: [],
      });
      assert.match(statements[1], /JOIN group_members/);
      assert.match(statements[1], /JOIN users/);
      statements = [];
      await assert.rejects(
        getGroup(participant, group.id),
        (error: { code: string }) => error.code === 'not_found',
      );
      assert.equal(statements.length, 2);
      const inviteKey = randomUUID();
      let inviteAudience: string[] = [];
      const invite = await trace(3, null, () =>
        createInvite(owner, inviteKey, group.id, {}, (userIds) => {
          inviteAudience = userIds;
        }),
      );
      assert.deepEqual(
        inviteAudience,
        [owner.userId],
        'capture the only invite-list viewer without another audience query',
      );
      assert.deepEqual(
        (await trace(3, null, () => getGroup(owner, group.id))).invites.map(
          (item) => item.id,
        ),
        [invite.id],
      );
      const replay = await trace(2, null, () =>
        createInvite(owner, inviteKey, group.id, {}),
      );
      assert.deepEqual(replay, {
        id: invite.id,
        inviteId: invite.id,
        linkUnavailable: true,
      });
      assert.ok(!JSON.stringify(replay).includes(invite.sharePath!));
      const token = invite.sharePath!.split('/').at(-1)!;
      assert.equal(token.length, 43);
      assert.equal(encodeURIComponent(token), token);
      const preview = await trace(2, null, () => getInvite(participant, token));
      assert.deepEqual(preview, {
        groupId: group.id,
        groupName: body.name,
        isMember: false,
        expiresAt: preview.expiresAt,
      });
      assert.match(statements[1], /JOIN users/);
      assert.match(statements[1], /LEFT JOIN group_members viewer/);
      assert.equal(
        (await trace(2, null, () => getInvite(owner, token))).isMember,
        true,
      );
      for (const malformed of [
        'a'.repeat(42),
        'a'.repeat(44),
        `${'a'.repeat(42)}+`,
        `${token}\n`,
      ]) {
        await trace(1, null, () =>
          assert.rejects(
            getInvite(participant, malformed),
            (error: { code: string }) => error.code === 'not_found',
          ),
        );
        await trace(1, null, () =>
          assert.rejects(
            acceptInvite(participant, randomUUID(), malformed),
            (error: { code: string }) => error.code === 'not_found',
          ),
        );
      }
      for (const [actor, input, expected, count] of [
        [participant, 'invalid', 'not_found', 1],
        [participant, randomBytes(32).toString('base64url'), 'not_found', 2],
        [null, 'invalid', 'unauthorized', 0],
        [
          { ...participant, userId: randomUUID() },
          'invalid',
          'unauthorized',
          1,
        ],
        [
          { ...participant, purpose: 'onboarding' as const },
          'invalid',
          'unauthorized',
          1,
        ],
      ] as const) {
        await trace(count, null, () =>
          assert.rejects(
            getInvite(actor, input),
            (error: { code: string }) => error.code === expected,
          ),
        );
      }
      const ownerOnboarding = (
        await client.query(
          'SELECT onboarding_completed_at FROM users WHERE id=$1',
          [owner.userId],
        )
      ).rows[0].onboarding_completed_at;
      for (const [change, restore, values] of [
        [
          'UPDATE users SET deleted_at=1 WHERE id=$1',
          'UPDATE users SET deleted_at=NULL WHERE id=$1',
          [owner.userId],
        ],
        [
          'UPDATE users SET onboarding_completed_at=NULL WHERE id=$1',
          'UPDATE users SET onboarding_completed_at=$2 WHERE id=$1',
          [owner.userId, ownerOnboarding],
        ],
        [
          'UPDATE group_members SET left_at=1 WHERE user_id=$1 AND group_id=$2',
          'UPDATE group_members SET left_at=NULL WHERE user_id=$1 AND group_id=$2',
          [owner.userId, group.id],
        ],
        [
          'UPDATE group_invites SET created_at=1,expires_at=2 WHERE id=$1',
          'UPDATE group_invites SET created_at=$2-604800,expires_at=$2 WHERE id=$1',
          [invite.id, preview.expiresAt],
        ],
      ] as const) {
        await client.query(
          change,
          values.slice(0, change.includes('$2') ? 2 : 1),
        );
        try {
          await trace(2, null, () =>
            assert.rejects(
              getInvite(participant, token),
              (error: { code: string }) => error.code === 'not_found',
            ),
          );
        } finally {
          await client.query(restore, [...values]);
        }
      }
      const acceptKey = randomUUID();
      let acceptAudience: string[] = [];
      await trace(5, 'session', () =>
        acceptInvite(participant, acceptKey, token, (ids) => {
          acceptAudience = ids;
        }),
      );
      assert.deepEqual(
        acceptAudience.sort(),
        [owner.userId, participant.userId].sort(),
      );
      assert.equal(
        (await trace(2, null, () => getInvite(participant, token))).isMember,
        true,
      );
      await trace(2, null, () => acceptInvite(participant, acceptKey, token));
      await trace(2, null, () =>
        assert.rejects(
          acceptInvite(
            participant,
            acceptKey,
            randomBytes(32).toString('base64url'),
          ),
          (error: { code: string }) => error.code === 'idempotency_conflict',
        ),
      );
      await trace(2, null, () =>
        assert.rejects(
          acceptInvite(participant, randomUUID(), token),
          (error: { code: string }) => error.code === 'group_already_member',
        ),
      );
      const concurrentMember = await member('동시 초대 수락');
      const concurrentAcceptKeys = Array.from({ length: 5 }, () =>
        randomUUID(),
      );
      statements = [];
      const accepts = await Promise.allSettled(
        concurrentAcceptKeys.map((key) =>
          acceptInvite(concurrentMember, key, token),
        ),
      );
      assert.equal(
        accepts.filter((result) => result.status === 'fulfilled').length,
        1,
      );
      assert.ok(
        accepts
          .filter((result) => result.status === 'rejected')
          .every((result) => result.reason.code === 'group_already_member'),
      );
      assert.ok(
        !statements.some((sql) =>
          /pg_advisory_lock\(|pg_advisory_unlock/.test(sql),
        ),
      );
      assert.equal(
        statements.filter((sql) => sql === 'BEGIN').length,
        statements.filter((sql) => sql === 'COMMIT' || sql === 'ROLLBACK')
          .length,
      );
      const winningKey =
        concurrentAcceptKeys[
          accepts.findIndex((result) => result.status === 'fulfilled')
        ];
      await trace(2, null, () =>
        acceptInvite(concurrentMember, winningKey, token),
      );
      assert.equal(
        (
          await client.query(
            'SELECT COUNT(*)::int AS count FROM group_members WHERE group_id=$1 AND left_at IS NULL',
            [group.id],
          )
        ).rows[0].count,
        3,
      );
      await leaveGroup(concurrentMember, randomUUID(), group.id);
      for (const [actor, input, key, expected, count] of [
        [outsider, 'invalid', randomUUID(), 'not_found', 1],
        [
          outsider,
          randomBytes(32).toString('base64url'),
          randomUUID(),
          'not_found',
          2,
        ],
        [outsider, token, 'invalid', 'invalid_request_key', 1],
        [null, 'invalid', randomUUID(), 'unauthorized', 0],
      ] as const) {
        await trace(count, null, () =>
          assert.rejects(
            acceptInvite(actor, key, input),
            (error: { code: string }) => error.code === expected,
          ),
        );
      }
      const failedAcceptKey = randomUUID(),
        acceptConstraint = `invite_accept_test_${randomUUID().replaceAll('-', '')}`;
      await client.query(
        `ALTER TABLE mutation_requests ADD CONSTRAINT ${acceptConstraint} CHECK (request_key <> '${failedAcceptKey}') NOT VALID`,
      );
      try {
        await trace(5, 'session', () =>
          assert.rejects(
            acceptInvite(outsider, failedAcceptKey, token),
            (error: { code: string }) => error.code === '23514',
          ),
        );
        assert.equal(
          (
            await client.query(
              'SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2',
              [group.id, outsider.userId],
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (
            await client.query(
              'SELECT COUNT(*)::int AS count FROM group_members WHERE group_id=$1 AND left_at IS NULL',
              [group.id],
            )
          ).rows[0].count,
          2,
        );
      } finally {
        await client.query(
          `ALTER TABLE mutation_requests DROP CONSTRAINT ${acceptConstraint}`,
        );
      }
      const recoveryKey = randomUUID();
      await trace(5, 'session', () =>
        acceptInvite(concurrentMember, recoveryKey, token),
      );
      assert.equal(
        (
          await client.query(
            'SELECT pg_try_advisory_lock(1684106607) AS acquired',
          )
        ).rows[0].acquired,
        true,
        'transaction completion releases the shared lock',
      );
      await client.query('SELECT pg_advisory_unlock(1684106607)');
      await leaveGroup(concurrentMember, randomUUID(), group.id);
      for (const [actor, code] of [
        [participant, 'forbidden'],
        [outsider, 'not_found'],
      ] as const) {
        statements = [];
        await assert.rejects(
          createInvite(actor, randomUUID(), group.id, {}),
          (error: { code: string }) => error.code === code,
        );
        assert.equal(statements.length, 2);
        assert.ok(
          statements.every(
            (sql) =>
              !/^(BEGIN|COMMIT|ROLLBACK|SET)\b/.test(sql) &&
              !sql.includes('pg_advisory_xact_lock'),
          ),
        );
      }
      await assert.rejects(
        createInvite(owner, inviteKey, group.id, {
          replaceInviteId: invite.id,
        }),
        (error: { code: string }) => error.code === 'idempotency_conflict',
      );
      const concurrentInviteKey = randomUUID();
      const concurrentInvites = await Promise.all(
        Array.from({ length: 5 }, () =>
          createInvite(owner, concurrentInviteKey, group.id, {}),
        ),
      );
      assert.equal(
        new Set(concurrentInvites.map((result) => result.id)).size,
        1,
      );
      assert.equal(
        concurrentInvites.filter((result) => result.sharePath).length,
        1,
      );
      await revokeInvite(
        owner,
        randomUUID(),
        group.id,
        concurrentInvites[0].id,
      );
      const second = await createGroup(owner, uuidV7(), {
        name: `${body.name} %_\\`,
      });
      const secondInvite = await createInvite(
        owner,
        randomUUID(),
        second.id,
        {},
      );
      const legacyToken = randomBytes(32).toString('base64url');
      await client.query('UPDATE group_invites SET token_hash=$2 WHERE id=$1', [
        secondInvite.id,
        createHash('sha256').update(legacyToken).digest('hex'),
      ]);
      assert.equal(
        (await trace(2, null, () => getInvite(participant, legacyToken)))
          .groupId,
        second.id,
        'previously issued base64url links still resolve',
      );
      await trace(5, 'session', () =>
        acceptInvite(participant, randomUUID(), legacyToken),
      );
      const orderedIds = [group.id, second.id].sort().reverse();
      // Reverse creation times so this fails if pagination still orders by created_at.
      for (const [index, id] of orderedIds.entries())
        await client.query('UPDATE groups SET created_at=$2 WHERE id=$1', [
          id,
          index + 1,
        ]);
      const combined = await trace(3, null, () =>
        listGroups(owner, new URLSearchParams()),
      );
      assert.deepEqual(
        combined.items.map((item) => item.id),
        orderedIds,
      );
      assert.ok(
        combined.items.every(
          (item) =>
            item.memberCount === 2 &&
            item.memberPreview[0].userId === owner.userId,
        ),
      );
      assert.equal(
        statements.filter((sql) => sql.includes('FROM "public"."users"'))
          .length,
        2,
        'one AUTH and one batch profile query, despite members shared across groups',
      );
      assert.equal(JSON.stringify(combined).includes('member_ids'), false);
      const firstPage = await trace(3, null, () =>
        listGroups(owner, new URLSearchParams({ q: body.name, limit: '1' })),
      );
      assert.equal(firstPage.items[0].id, orderedIds[0]);
      assert.ok(firstPage.nextCursor);
      const nextPage = await trace(3, null, () =>
        listGroups(
          owner,
          new URLSearchParams({
            q: body.name,
            limit: '1',
            cursor: firstPage.nextCursor!,
          }),
        ),
      );
      assert.deepEqual(
        nextPage.items.map((item) => item.id),
        [orderedIds[1]],
      );
      assert.equal(nextPage.nextCursor, null);
      for (const q of ['%_', '\\']) {
        assert.deepEqual(
          (
            await trace(3, null, () =>
              listGroups(owner, new URLSearchParams({ q })),
            )
          ).items.map((item) => item.id),
          [second.id],
          'LIKE metacharacters match literally',
        );
      }
      await leaveGroup(owner, randomUUID(), second.id);
      const detail = await trace(2, null, () =>
        getGroup(participant, group.id),
      );
      assert.equal(detail.isCreator, false);
      assert.deepEqual(detail.members, [
        { userId: owner.userId, displayName: '모임 생성자', excludedAt: null },
        {
          userId: participant.userId,
          displayName: '모임 참여자',
          excludedAt: null,
        },
      ]);
      assert.ok(statements.every((sql) => !sql.includes('group_invites')));
      assert.deepEqual(detail.invites, []);
      const withdrawn = await member('탈퇴 멤버'),
        incomplete = await member('미가입 멤버');
      for (const actor of [withdrawn, incomplete])
        await acceptInvite(actor, randomUUID(), token);
      await client.query('UPDATE users SET deleted_at=1 WHERE id=$1', [
        withdrawn.userId,
      ]);
      await client.query(
        'UPDATE users SET onboarding_completed_at=NULL WHERE id=$1',
        [incomplete.userId],
      );
      await client.query('UPDATE users SET display_name=NULL WHERE id=$1', [
        participant.userId,
      ]);
      const activeDetail = await trace(3, null, () =>
        getGroup(owner, group.id),
      );
      assert.deepEqual(activeDetail.members, [
        { userId: owner.userId, displayName: '모임 생성자', excludedAt: null },
        {
          userId: participant.userId,
          displayName: '카카오 사용자',
          excludedAt: null,
        },
      ]);
      await assert.rejects(
        getGroup(withdrawn, group.id),
        (error: { code: string }) => error.code === 'unauthorized',
      );
      await assert.rejects(
        getGroup(incomplete, group.id),
        (error: { code: string }) => error.code === 'onboarding_required',
      );
      for (const [actor, expected] of [
        [withdrawn, 'unauthorized'],
        [incomplete, 'onboarding_required'],
      ] as const) {
        await trace(1, null, () =>
          assert.rejects(
            getInvite(actor, 'invalid'),
            (error: { code: string }) => error.code === expected,
          ),
        );
      }
      statements = [];
      await assert.rejects(
        leaveGroup(withdrawn, randomUUID(), group.id),
        (error: { code: string }) => error.code === 'unauthorized',
      );
      assert.ok(
        statements.every((sql) => !sql.includes('pg_advisory_xact_lock')),
      );
      statements = [];
      await assert.rejects(
        getGroup(participant, randomUUID()),
        (error: { code: string }) => error.code === 'not_found',
      );
      assert.equal(statements.length, 2);
      const failedKey = randomUUID();
      statements = [];
      await assert.rejects(
        createInvite(owner, failedKey, group.id, {
          replaceInviteId: randomUUID(),
        }),
        (error: { code: string }) => error.code === 'not_found',
      );
      assert.equal(statements.length, 3);
      assert.ok(
        statements.every(
          (sql) =>
            !/^(BEGIN|COMMIT|ROLLBACK|SET)\b/.test(sql) &&
            !sql.includes('pg_advisory_xact_lock'),
        ),
      );
      assert.equal(
        (
          await client.query(
            'SELECT 1 FROM mutation_requests WHERE request_key=$1',
            [failedKey],
          )
        ).rows.length,
        0,
      );
      const failedReplacementKey = randomUUID(),
        inviteConstraint = `invite_create_test_${randomUUID().replaceAll('-', '')}`;
      await client.query(
        `ALTER TABLE mutation_requests ADD CONSTRAINT ${inviteConstraint} CHECK (request_key <> '${failedReplacementKey}') NOT VALID`,
      );
      try {
        await assert.rejects(
          createInvite(owner, failedReplacementKey, group.id, {
            replaceInviteId: invite.id,
          }),
          (error: { code: string }) => error.code === '23514',
        );
        assert.equal(
          (
            await client.query(
              'SELECT revoked_at FROM group_invites WHERE id=$1',
              [invite.id],
            )
          ).rows[0].revoked_at,
          null,
        );
        assert.deepEqual(
          (await getGroup(owner, group.id)).invites.map((item) => item.id),
          [invite.id],
          'failed metadata INSERT rolls back both replacement writes',
        );
      } finally {
        await client.query(
          `ALTER TABLE mutation_requests DROP CONSTRAINT ${inviteConstraint}`,
        );
      }
      const replaced = await trace(3, null, () =>
        createInvite(owner, randomUUID(), group.id, {
          replaceInviteId: invite.id,
        }),
      );
      await trace(2, null, () =>
        assert.rejects(
          getInvite(participant, token),
          (error: { code: string }) => error.code === 'not_found',
        ),
      );
      for (const [actor, target, inviteId, requestKey, expected, count] of [
        [participant, group.id, replaced.id, randomUUID(), 'forbidden', 2],
        [outsider, group.id, replaced.id, randomUUID(), 'not_found', 2],
        [owner, randomUUID(), replaced.id, randomUUID(), 'not_found', 2],
        [owner, group.id, randomUUID(), randomUUID(), 'not_found', 3],
        [owner, group.id, secondInvite.id, randomUUID(), 'not_found', 3],
        [owner, group.id, replaced.id, 'invalid', 'invalid_request_key', 1],
        [withdrawn, group.id, replaced.id, randomUUID(), 'unauthorized', 1],
        [
          incomplete,
          group.id,
          replaced.id,
          randomUUID(),
          'onboarding_required',
          1,
        ],
        [null, group.id, replaced.id, randomUUID(), 'unauthorized', 0],
      ] as const) {
        await trace(count, null, () =>
          assert.rejects(
            revokeInvite(actor, requestKey, target, inviteId),
            (error: { code: string }) => error.code === expected,
          ),
        );
      }
      const failedRevokeKey = randomUUID(),
        revokeConstraint = `invite_revoke_test_${randomUUID().replaceAll('-', '')}`;
      await client.query(
        `ALTER TABLE mutation_requests ADD CONSTRAINT ${revokeConstraint} CHECK (request_key <> '${failedRevokeKey}') NOT VALID`,
      );
      try {
        await trace(3, null, () =>
          assert.rejects(
            revokeInvite(owner, failedRevokeKey, group.id, replaced.id),
            (error: { code: string }) => error.code === '23514',
          ),
        );
        assert.equal(
          (
            await client.query(
              'SELECT revoked_at FROM group_invites WHERE id=$1',
              [replaced.id],
            )
          ).rows[0].revoked_at,
          null,
          'failed metadata INSERT rolls back revocation in the same statement',
        );
      } finally {
        await client.query(
          `ALTER TABLE mutation_requests DROP CONSTRAINT ${revokeConstraint}`,
        );
      }
      const revokeKey = randomUUID();
      let revokeAudience: string[] = [];
      const revoked = await trace(3, null, () =>
        revokeInvite(owner, revokeKey, group.id, replaced.id, (ids) => {
          revokeAudience = ids;
        }),
      );
      assert.deepEqual(revoked, { id: replaced.id });
      assert.deepEqual(
        revokeAudience,
        [owner.userId],
        'capture the only invite-list viewer without another audience query',
      );
      const revokedAt = (
        await client.query('SELECT revoked_at FROM group_invites WHERE id=$1', [
          replaced.id,
        ])
      ).rows[0].revoked_at;
      assert.deepEqual(
        await trace(2, null, () =>
          revokeInvite(owner, revokeKey, group.id, replaced.id),
        ),
        revoked,
      );
      await trace(2, null, () =>
        assert.rejects(
          revokeInvite(owner, revokeKey, group.id, invite.id),
          (error: { code: string }) => error.code === 'idempotency_conflict',
        ),
      );
      await trace(3, null, () =>
        revokeInvite(owner, randomUUID(), group.id, replaced.id),
      );
      assert.equal(
        (
          await client.query(
            'SELECT revoked_at FROM group_invites WHERE id=$1',
            [replaced.id],
          )
        ).rows[0].revoked_at,
        revokedAt,
      );
      const concurrentRevokeKey = randomUUID();
      assert.deepEqual(
        await Promise.all(
          Array.from({ length: 5 }, () =>
            revokeInvite(owner, concurrentRevokeKey, group.id, replaced.id),
          ),
        ),
        Array(5).fill(revoked),
      );
      await assert.rejects(
        getInvite(participant, replaced.sharePath!.split('/').at(-1)!),
        (error: { code: string }) => error.code === 'not_found',
      );
      assert.deepEqual(
        (await trace(3, null, () => getGroup(owner, group.id))).invites,
        [],
      );
      const unfinished = await createRound(owner, uuidV7(), group.id, {
        name: '미종료 검사',
        participantIds: [owner.userId, participant.userId],
      });
      for (const status of ['RECORDING', 'CONFIRMED', 'LOCKED']) {
        await client.query(
          `UPDATE rounds SET status=$2,
          confirmed_at=CASE WHEN $2='RECORDING' THEN NULL ELSE created_at END,
          locked_at=CASE WHEN $2='LOCKED' THEN created_at ELSE NULL END WHERE id=$1`,
          [unfinished.id, status],
        );
        for (const actor of [owner, participant]) {
          statements = [];
          await assert.rejects(
            leaveGroup(actor, randomUUID(), group.id),
            (error: { code: string }) =>
              error.code ===
              (actor === owner
                ? 'unfinished_group_rounds'
                : 'unfinished_rounds'),
          );
          assert.equal(statements.length, 5, statements.join('\n'));
          assert.equal(statements.at(-1), 'ROLLBACK');
          assert.match(statements[1], /FROM "public"\."users"/);
          assert.ok(statements[2].includes('pg_advisory_xact_lock'));
        }
      }
      await client.query(
        "UPDATE rounds SET status='COMPLETED',finalized_at=created_at,completed_at=created_at WHERE id=$1",
        [unfinished.id],
      );
      const rollbackInvite = await createInvite(
        owner,
        randomUUID(),
        group.id,
        {},
      );
      const failedDepartureKey = randomUUID(),
        departureConstraint = `group_leave_test_${randomUUID().replaceAll('-', '')}`;
      await client.query(
        `ALTER TABLE mutation_requests ADD CONSTRAINT ${departureConstraint} CHECK (request_key <> '${failedDepartureKey}') NOT VALID`,
      );
      try {
        await assert.rejects(
          leaveGroup(owner, failedDepartureKey, group.id),
          (error: { code: string }) => error.code === '23514',
        );
        assert.equal(
          (
            await client.query(
              'SELECT COUNT(*)::int AS count FROM group_members WHERE group_id=$1 AND left_at IS NULL',
              [group.id],
            )
          ).rows[0].count,
          4,
        );
        assert.equal(
          (
            await client.query(
              'SELECT revoked_at FROM group_invites WHERE id=$1',
              [rollbackInvite.id],
            )
          ).rows[0].revoked_at,
          null,
        );
      } finally {
        await client.query(
          `ALTER TABLE mutation_requests DROP CONSTRAINT ${departureConstraint}`,
        );
      }
      for (const [actor, target, requestKey, expected] of [
        [outsider, group.id, randomUUID(), 'not_found'],
        [owner, randomUUID(), randomUUID(), 'not_found'],
        [owner, group.id, 'invalid', 'invalid_request_key'],
      ] as const) {
        await assert.rejects(
          leaveGroup(actor, requestKey, target),
          (error: { code: string }) => error.code === expected,
        );
      }
      const leaveKey = randomUUID();
      let audience: string[] = [];
      await trace(6, true, () =>
        leaveGroup(participant, leaveKey, group.id, (ids) => {
          audience = ids;
        }),
      );
      assert.equal(
        (
          await trace(2, null, () =>
            getInvite(
              participant,
              rollbackInvite.sharePath!.split('/').at(-1)!,
            ),
          )
        ).isMember,
        false,
      );
      assert.ok(
        audience.includes(owner.userId) &&
          audience.includes(participant.userId),
      );
      await trace(5, true, () => leaveGroup(participant, leaveKey, group.id));
      await assert.rejects(
        leaveGroup(participant, leaveKey, second.id),
        (error: { code: string }) => error.code === 'idempotency_conflict',
      );
      statements = [];
      await assert.rejects(
        getGroup(participant, group.id),
        (error: { code: string }) => error.code === 'not_found',
      );
      assert.equal(statements.length, 2);
      assert.deepEqual(
        (await trace(3, null, () => getGroup(owner, group.id))).members.map(
          (member) => member.userId,
        ),
        [owner.userId],
      );
      const closeKey = randomUUID();
      await trace(6, true, () =>
        leaveGroup(owner, closeKey, group.id, (ids) => {
          audience = ids;
        }),
      );
      await trace(5, true, () => leaveGroup(owner, closeKey, group.id));
      assert.notEqual(
        (
          await client.query(
            'SELECT revoked_at FROM group_invites WHERE id=$1',
            [rollbackInvite.id],
          )
        ).rows[0].revoked_at,
        null,
      );
      assert.equal(
        (
          await trace(2, null, () =>
            listGroups(owner, new URLSearchParams({ q: body.name })),
          )
        ).items.length,
        0,
      );
      assert.equal(
        (
          await client.query(
            'SELECT COUNT(*)::int AS count FROM group_members WHERE group_id=$1 AND left_at IS NULL',
            [group.id],
          )
        ).rows[0].count,
        0,
      );
      assert.equal(
        (await getRound(participant, unfinished.id, new URLSearchParams())).id,
        unfinished.id,
        'past rounds survive departure',
      );
      const publisher = t.mock.fn((userId: string, keys: string[]) => {});
      const publications = await testProvider(RealtimePublisher);
      const unregister = publications.registerInvalidationPublisher(publisher);
      try {
        await trace(0, null, () =>
          publications.publishGroupInvalidation(group.id, audience),
        );
        assert.deepEqual(
          publisher.mock.calls.map(({ arguments: [userId, keys] }) => ({
            userId,
            keys,
          })),
          audience.map((userId) => ({
            userId,
            keys: ['groups', `group:${group.id}`],
          })),
        );
      } finally {
        unregister();
      }
      const otherRounds = await createGroup(owner, uuidV7(), {
        name: '본인이 참여하지 않은 회차',
      });
      const otherInvite = await createInvite(
        owner,
        randomUUID(),
        otherRounds.id,
        {},
      );
      for (const actor of [participant, outsider])
        await acceptInvite(
          actor,
          randomUUID(),
          otherInvite.sharePath!.split('/').at(-1)!,
        );
      const otherRound = await createRound(
        participant,
        uuidV7(),
        otherRounds.id,
        {
          name: '다른 참여자 회차',
          participantIds: [participant.userId, outsider.userId],
        },
      );
      const excludedRound = await createRound(
        participant,
        uuidV7(),
        otherRounds.id,
        {
          name: '본인이 제외된 회차',
          participantIds: [owner.userId, participant.userId],
        },
      );
      await client.query(
        'UPDATE round_members SET excluded_at=joined_at WHERE round_id=$1 AND user_id=$2',
        [excludedRound.id, owner.userId],
      );
      await assert.rejects(
        leaveGroup(owner, randomUUID(), otherRounds.id),
        (error: { code: string }) => error.code === 'unfinished_group_rounds',
      );
      assert.equal(
        (await getRound(participant, otherRound.id, new URLSearchParams()))
          .status,
        'RECORDING',
      );
      await client.query(
        'UPDATE round_members SET excluded_at=joined_at WHERE round_id=$1 AND user_id=$2',
        [otherRound.id, outsider.userId],
      );
      await trace(6, true, () =>
        leaveGroup(outsider, randomUUID(), otherRounds.id),
      );
      for (const round of [otherRound, excludedRound])
        await roundCommand(participant, randomUUID(), round.id, 'cancel', {
          expectedVersion: 1,
        });
      await trace(6, true, () =>
        leaveGroup(owner, randomUUID(), otherRounds.id),
      );
    } finally {
      logger.mock.restore();
      if (previous === undefined) delete process.env.DB_QUERY_LOG;
      else process.env.DB_QUERY_LOG = previous;
    }
  } finally {
    await client.end();
  }
});

before(async () => {
  await getPrismaClient(process.env.TEST_DATABASE_URL!);
});
