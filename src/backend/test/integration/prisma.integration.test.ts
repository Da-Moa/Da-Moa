import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { getPrismaClient } from '../support/domainTestSupport';
import { createDatabaseClient } from '../../global/database/db';
import {
  withDatabaseConnection,
  withWriteTransaction,
} from '../support/domainTestSupport';
import { signInKakao } from '../support/domainTestSupport';
import { applyMigrations } from '../../../../scripts/migrations.mjs';
const url = process.env.TEST_DATABASE_URL;
if (
  !url ||
  !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname) ||
  !new URL(url).pathname.includes('test')
)
  throw new Error('An isolated local test database is required');
process.env.DATABASE_URL = url;
process.env.AUTH_JWT_SECRET ||=
  'prisma-integration-only-secret-at-least-32-bytes';

test('Prisma models read migrated accounts and transactions roll back model writes', async (t) => {
  const native = createDatabaseClient(url);
  await native.connect();
  t.after(() => native.end());
  await applyMigrations(native);
  const prisma = await getPrismaClient(url);
  const session = await signInKakao(`prisma-test:${randomUUID()}`, {
    displayName: 'ORM 확인',
    email: null,
    profileImageUrl: null,
  });
  const account = await prisma.users.findUniqueOrThrow({
    where: { id: session.userId },
  });
  assert.equal(account.display_name, 'ORM 확인');
  assert.equal(typeof account.created_at, 'bigint');
  const failure = new Error('rollback model write');
  await assert.rejects(
    withWriteTransaction(async (client) => {
      await client.prisma.users.update({
        where: { id: session.userId },
        data: { display_name: '롤백' },
      });
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(
    (await prisma.users.findUniqueOrThrow({ where: { id: session.userId } }))
      .display_name,
    'ORM 확인',
  );
  assert.equal(
    await withDatabaseConnection(
      async (client) =>
        (await client.query('SELECT $1::text AS value', ['bound parameter']))
          .rows[0].value,
    ),
    'bound parameter',
  );
  await prisma.users.delete({ where: { id: session.userId } });
});
