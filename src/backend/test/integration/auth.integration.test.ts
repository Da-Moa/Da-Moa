import { getPrismaClient } from '../support/domainTestSupport.ts';
import { uuidV7 } from '../../../shared/uuid.ts';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { before, test } from 'node:test';
import {
  currentTimestamp,
  type AccessToken,
} from '../../global/auth/native.ts';
import {
  createAccessToken,
  createRefreshToken,
  readAccessToken,
  readRefreshToken,
} from '../support/legacyTokenTestSupport.ts';
import { withdrawAccount, testProvider } from '../support/domainTestSupport.ts';
import { TokenService } from '../../global/auth/service/token.service';
import { type AuthSession } from '../../global/auth/index.ts';
import { signInKakao } from '../support/domainTestSupport.ts';
import { getAccount } from '../support/domainTestSupport.ts';
import { createDatabaseClient } from '../../global/database/db.ts';
import {
  withReadTransaction,
  withWriteTransaction,
} from '../support/domainTestSupport.ts';
import { AppError } from '../../global/apiPayload/errors.ts';
import {
  acceptInvite,
  createGroup,
  createInvite,
  getGroup,
  getInvite,
  listGroups,
} from '../support/domainTestSupport.ts';
import { applyMigrations } from '../../../../scripts/migrations.mjs';
import {
  completeTestOnboarding as completeOnboarding,
  updateTestBankAccount as updateBankAccount,
} from './bankTestSupport.ts';

const testUrl = process.env.TEST_DATABASE_URL;
if (
  !testUrl ||
  !['localhost', '127.0.0.1', '[::1]'].includes(new URL(testUrl).hostname) ||
  !new URL(testUrl).pathname.toLowerCase().includes('test')
)
  throw new Error(
    'TEST_DATABASE_URL must name an isolated local test database; authentication tests never use DATABASE_URL implicitly',
  );
process.env.DATABASE_URL = testUrl;
process.env.AUTH_JWT_SECRET =
  'isolated-auth-integration-test-secret-at-least-32-bytes';

const bank = {
  bankName: '테스트 은행',
  accountNumber: '1234-03-12345678',
  accountHolder: '테스트 사용자',
};
const profile = {
  displayName: '검증 사용자',
  email: null,
  profileImageUrl: null,
};
const accessOf = (session: AuthSession): AccessToken => {
  const access = readAccessToken(session.accessToken);
  assert.ok(access);
  return access;
};
const codeIs = (code: string) => (error: unknown) =>
  error instanceof AppError && error.code === code;

async function newAccount() {
  const subject = `integration-${randomUUID()}`;
  const onboarding = await signInKakao(subject, profile);
  assert.equal(onboarding.purpose, 'onboarding');
  const session = await completeOnboarding(accessOf(onboarding), bank);
  return { subject, onboarding, session, access: accessOf(session) };
}

async function assertCurrencyUpgrade(
  client: ReturnType<typeof createDatabaseClient>,
) {
  const schema = `currency_upgrade_${randomUUID().replaceAll('-', '')}`;
  await client.query(`CREATE SCHEMA ${schema}`);
  try {
    await client.query(`SET search_path TO ${schema}`);
    await client.query(
      'CREATE TABLE schema_migrations(version TEXT PRIMARY KEY, applied_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::BIGINT)',
    );
    for (const version of [
      '001-auth-lifecycle.sql',
      '002-groups-settlement.sql',
      '003-round-cascade-constraints.sql',
    ]) {
      await client.query(
        await readFile(
          new URL(`../../../../scripts/migrations/${version}`, import.meta.url),
          'utf8',
        ),
      );
      await client.query(
        'INSERT INTO schema_migrations(version,applied_at) VALUES($1,1)',
        [version],
      );
    }
    const userId = randomUUID(),
      legacyMemberId = randomUUID(),
      sessionId = randomUUID(),
      now = currentTimestamp();
    await client.query(
      `INSERT INTO users(id,provider,provider_subject,created_at,updated_at,bank_name,account_number,account_holder,bank_updated_at,onboarding_completed_at)
      VALUES($1,'kakao',$1,$2,$2,'기존 은행','001234','기존 회원',$2,$2)`,
      [userId, now],
    );
    await client.query(
      `INSERT INTO users(id,provider,provider_subject,created_at,updated_at,bank_name,account_number,account_holder,bank_updated_at,onboarding_completed_at)
      VALUES($1,'kakao',$1,$2,$2,'기존 은행','005678','기존 참여자',$2,$2)`,
      [legacyMemberId, now],
    );
    await client.query(
      `INSERT INTO refresh_sessions(id,user_id,token_hash,issued_at,expires_at,purpose)
      VALUES($1,$2,$3,$4,$5,'app')`,
      [
        sessionId,
        userId,
        createHash('sha256').update(sessionId).digest('hex'),
        now,
        now + 1000,
      ],
    );
    let missingCreatorRoundId = '',
      lateJoinedRoundId = '';
    for (const currency of ['KRW', 'USD', 'JPY']) {
      const groupId = randomUUID(),
        roundId = randomUUID();
      await client.query(
        'INSERT INTO groups(id,creator_id,name,base_currency,created_at) VALUES($1,$2,$3,$3,$4)',
        [groupId, userId, currency, now],
      );
      await client.query(
        'INSERT INTO group_members(group_id,user_id,joined_at) VALUES($1,$2,$3)',
        [groupId, userId, now],
      );
      await client.query(
        "INSERT INTO rounds(id,group_id,name,currency,status,created_at) VALUES($1,$2,'기존 회차',$3,'RECORDING',$4)",
        [roundId, groupId, currency, now],
      );
      await client.query(
        "INSERT INTO round_members(round_id,user_id,display_name_snapshot,joined_at) VALUES($1,$2,'기존 회원',$3)",
        [roundId, userId, now],
      );
      if (currency === 'KRW') {
        lateJoinedRoundId = roundId;
        await client.query(
          'INSERT INTO group_members(group_id,user_id,joined_at) VALUES($1,$2,$3)',
          [groupId, legacyMemberId, now],
        );
        await client.query(
          "INSERT INTO round_members(round_id,user_id,display_name_snapshot,joined_at) VALUES($1,$2,'기존 참여자',$3)",
          [roundId, legacyMemberId, now + 1],
        );
        await client.query(
          "UPDATE rounds SET status='COMPLETED',confirmed_at=$2,locked_at=$2,finalized_at=$2,completed_at=$2 WHERE id=$1",
          [roundId, now],
        );
        await client.query(
          'INSERT INTO settlement_transfers(round_id,sender_id,receiver_id,amount_minor) VALUES($1,$2,$3,1)',
          [roundId, legacyMemberId, userId],
        );
      }
      if (currency !== 'JPY') {
        const expenseId = randomUUID();
        await client.query(
          `INSERT INTO expenses(id,round_id,author_id,payer_id,description,amount_minor,split_mode,created_at,updated_at,updated_by)
          VALUES($1,$2,$3,$3,'기존 통화 지출',123456789,'ALL',$4,$4,$3)`,
          [expenseId, roundId, userId, now],
        );
        await client.query(
          'INSERT INTO expense_shares(expense_id,round_id,user_id) VALUES($1,$2,$3)',
          [expenseId, roundId, userId],
        );
        await client.query(
          'INSERT INTO settlement_balances(round_id,user_id,paid_minor,burden_minor,balance_minor) VALUES($1,$2,123456789,123456789,0)',
          [roundId, userId],
        );
      }
      if (currency === 'JPY') missingCreatorRoundId = roundId;
    }
    await client.query(
      'DELETE FROM round_members WHERE round_id=$1 AND user_id=$2',
      [missingCreatorRoundId, userId],
    );
    const beforeRounds = (
      await client.query('SELECT * FROM rounds ORDER BY id')
    ).rows;
    const beforeExpenses = (
      await client.query('SELECT * FROM expenses ORDER BY id')
    ).rows;
    const beforeBalances = (
      await client.query(
        'SELECT * FROM settlement_balances ORDER BY round_id,user_id',
      )
    ).rows;
    const beforeSession = (
      await client.query('SELECT * FROM refresh_sessions WHERE id=$1', [
        sessionId,
      ])
    ).rows;
    for (const version of [
      '004-round-currency.sql',
      '005-round-creator.sql',
      '006-receipt-avif.sql',
      '007-settlement-check.sql',
    ]) {
      await client.query(
        await readFile(
          new URL(`../../../../scripts/migrations/${version}`, import.meta.url),
          'utf8',
        ),
      );
      await client.query(
        'INSERT INTO schema_migrations(version,applied_at) VALUES($1,1)',
        [version],
      );
    }
    const backfilledCreator = (
      await client.query(
        `SELECT rm.display_name_snapshot,rm.joined_at,r.created_at FROM round_members rm
      JOIN rounds r ON r.id=rm.round_id WHERE rm.round_id=$1 AND rm.user_id=$2`,
        [missingCreatorRoundId, userId],
      )
    ).rows[0];
    assert.equal(backfilledCreator.display_name_snapshot, '카카오 사용자');
    assert.equal(
      backfilledCreator.joined_at,
      backfilledCreator.created_at,
      '005 must restore a missing legacy creator membership at round creation',
    );
    const correctedMembership = (
      await client.query(
        `SELECT rm.joined_at,r.completed_at FROM round_members rm
      JOIN rounds r ON r.id=rm.round_id WHERE rm.round_id=$1 AND rm.user_id=$2`,
        [lateJoinedRoundId, legacyMemberId],
      )
    ).rows[0];
    assert.equal(
      correctedMembership.joined_at,
      correctedMembership.completed_at,
      '007 must repair a legacy member timestamp later than completion',
    );
    assert.equal(
      (
        await client.query(`SELECT count(*)::int AS count FROM round_members rm JOIN rounds r ON r.id=rm.round_id
      WHERE r.status='COMPLETED' AND rm.settlement_checked_at=r.completed_at`)
      ).rows[0].count,
      2,
      '007 must persist its receiver-level state before 008 runs later',
    );
    await applyMigrations(client);
    const upgradedRounds = (
      await client.query('SELECT * FROM rounds ORDER BY id')
    ).rows;
    assert.deepEqual(
      upgradedRounds.map(({ creator_id: _, ...round }) => round),
      beforeRounds.map(({ currency: _, ...round }) => round),
      '016 removes round currency while preserving historical round fields',
    );
    assert.ok(
      upgradedRounds.every((round) => round.creator_id === userId),
      '005 must assign the prior group creator to existing rounds',
    );
    const legacyCurrency = new Map(
      beforeRounds.map((round) => [round.id, round.currency]),
    );
    const expenses = (await client.query('SELECT * FROM expenses ORDER BY id'))
      .rows;
    const balances = (
      await client.query(
        'SELECT * FROM settlement_balances ORDER BY round_id,user_id',
      )
    ).rows;
    assert.deepEqual(
      expenses.map(({ currency: _, ...row }) => row),
      beforeExpenses,
    );
    assert.deepEqual(
      balances.map(({ currency: _, ...row }) => row),
      beforeBalances,
    );
    assert.ok(
      [...expenses, ...balances].every(
        (row) => row.currency === legacyCurrency.get(row.round_id),
      ),
    );
    assert.ok(
      (
        await client.query('SELECT round_id,currency FROM settlement_transfers')
      ).rows.every((row) => row.currency === legacyCurrency.get(row.round_id)),
    );
    assert.equal(
      (
        await client.query(
          "SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='rounds' AND column_name='currency'",
          [schema],
        )
      ).rowCount,
      0,
    );
    assert.deepEqual(
      (
        await client.query('SELECT * FROM refresh_sessions WHERE id=$1', [
          sessionId,
        ])
      ).rows,
      beforeSession,
      '004 must not revoke or replace existing app sessions',
    );
    assert.equal(
      (
        await client.query(
          "SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='groups' AND column_name='base_currency'",
          [schema],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await client.query(
          "SELECT 1 FROM schema_migrations WHERE version='004-round-currency.sql'",
        )
      ).rowCount,
      1,
    );
    assert.equal(
      (
        await client.query(
          "SELECT 1 FROM schema_migrations WHERE version='005-round-creator.sql'",
        )
      ).rowCount,
      1,
    );
    assert.equal(
      (
        await client.query(
          "SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='round_members' AND column_name='settlement_checked_at'",
          [schema],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await client.query(
          "SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='settlement_transfers' AND column_name='received_at'",
          [schema],
        )
      ).rowCount,
      1,
    );
    assert.equal(
      (
        await client.query(
          "SELECT 1 FROM schema_migrations WHERE version='007-settlement-check.sql'",
        )
      ).rowCount,
      1,
    );
    assert.equal(
      (
        await client.query(
          "SELECT 1 FROM schema_migrations WHERE version='008-transfer-receipt-check.sql'",
        )
      ).rowCount,
      1,
    );
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS count FROM settlement_transfers t JOIN rounds r ON r.id=t.round_id WHERE r.status='COMPLETED' AND t.received_at=r.completed_at",
        )
      ).rows[0].count,
      1,
    );
  } finally {
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA ${schema} CASCADE`);
  }
}

before(async () => {
  const client = createDatabaseClient(process.env.TEST_DATABASE_URL!);
  try {
    await client.connect();
    await applyMigrations(client);
  } finally {
    await client.end();
  }
});

test('onboarding purpose, bank normalization, version conflicts, stateless authentication, and historical migration', async () => {
  const subject = `integration-${randomUUID()}`;
  const limited = await signInKakao(subject, profile);
  const limitedAccess = accessOf(limited);
  assert.equal(limited.accessMaxAge, 600);
  assert.equal(
    (await getAccount(limitedAccess, true)).onboardingCompletedAt,
    null,
  );
  await assert.rejects(
    getAccount(limitedAccess),
    codeIs('onboarding_required'),
  );
  await assert.rejects(
    createGroup(limitedAccess, uuidV7(), { name: '제한 세션 모임' }),
    codeIs('onboarding_required'),
  );

  const app = await completeOnboarding(limitedAccess, bank);
  const access = accessOf(app);
  assert.equal(app.userId, limited.userId);
  assert.equal((await getAccount(access)).accountNumber, '12340312345678');
  await assert.rejects(getAccount(limitedAccess, true), codeIs('unauthorized'));
  await assert.rejects(
    completeOnboarding(limitedAccess, bank),
    codeIs('unauthorized'),
  );

  const key = randomUUID();
  const nextBank = { ...bank, accountNumber: '12340312345679' };
  const result = await updateBankAccount(access, key, nextBank);
  assert.deepEqual(result, { id: app.userId, bankVersion: 2 });
  await assert.rejects(
    updateBankAccount(access, key, nextBank),
    codeIs('bank_account_conflict'),
  );
  await assert.rejects(
    updateBankAccount(access, key, {
      ...nextBank,
      accountNumber: '12340312345670',
    }),
    codeIs('bank_account_conflict'),
  );
  assert.equal((await getAccount(access)).accountNumber, '12340312345679');
  const mutation = await withReadTransaction(async (client) =>
    client.query(
      'SELECT response_metadata FROM mutation_requests WHERE actor_id=$1 AND request_key=$2',
      [app.userId, key],
    ),
  );
  assert.deepEqual(mutation.rows, []);

  const client = createDatabaseClient(process.env.TEST_DATABASE_URL!);
  try {
    await client.connect();
    await applyMigrations(client);
    await assertCurrencyUpgrade(client);
  } finally {
    await client.end();
  }
  assert.equal(
    (await getAccount(access)).id,
    app.userId,
    'repeated migrations must not revoke newer sessions',
  );
  assert.equal((await getAccount(access)).id, app.userId);
});

test('withdrawal checks all unfinished history including excluded members; rejoin preserves identity but never memberships', async () => {
  const owner = await newAccount();
  const participant = await newAccount();
  const third = await newAccount();
  const group = await createGroup(owner.access, uuidV7(), {
    name: '회원 상태 검증',
  });
  const invite = await createInvite(owner.access, randomUUID(), group.id, {});
  const token = invite.sharePath!.split('/').at(-1)!;
  await acceptInvite(participant.access, randomUUID(), token);
  await acceptInvite(third.access, randomUUID(), token);
  const roundIds = [randomUUID(), randomUUID()];
  const now = currentTimestamp();
  await withWriteTransaction(async (client) => {
    for (const id of roundIds) {
      await client.query(
        "INSERT INTO rounds(id,group_id,creator_id,name,status,created_at) VALUES($1,$2,$3,'진행 회차','RECORDING',$4)",
        [id, group.id, owner.session.userId, now],
      );
      for (const userId of [
        owner.session.userId,
        participant.session.userId,
        third.session.userId,
      ]) {
        await client.query(
          'INSERT INTO round_members(round_id,user_id,display_name_snapshot,joined_at,excluded_at) VALUES($1,$2,$3,$4,$5)',
          [
            id,
            userId,
            profile.displayName,
            now,
            userId === participant.session.userId ? now : null,
          ],
        );
      }
    }
  });
  const replacedDuringSettlement = await updateBankAccount(
    participant.access,
    randomUUID(),
    { ...bank, accountNumber: '12340312345670' },
  );
  assert.equal(
    replacedDuringSettlement.bankVersion,
    2,
    'unfinished settlement blocks withdrawal but permits verified representative account replacement',
  );
  assert.equal(
    (await getAccount(participant.access)).accountNumber,
    '12340312345670',
  );
  await assert.rejects(withdrawAccount(participant.access), (error) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'unfinished_rounds');
    assert.deepEqual(
      new Set(
        (error.details as { rounds: { id: string }[] }).rounds.map(
          (round) => round.id,
        ),
      ),
      new Set(roundIds),
    );
    return true;
  });
  assert.equal((await getAccount(participant.access)).deletedAt, null);
  await withWriteTransaction(async (client) => {
    await client.query('DELETE FROM rounds WHERE id=$1', [roundIds[0]]);
  });
  await assert.rejects(
    withdrawAccount(participant.access),
    codeIs('unfinished_rounds'),
  );
  // A completed historical round with no net payments is retained as an imported historical fixture.
  await withWriteTransaction(async (client) => {
    const id = roundIds[1];
    const expenseId = randomUUID();
    await client.query(
      'UPDATE round_members SET excluded_at=NULL WHERE round_id=$1',
      [id],
    );
    await client.query(
      `INSERT INTO expenses(id,round_id,author_id,payer_id,description,amount_minor,split_mode,base_share_minor,remainder_units,created_at,updated_at,updated_by,currency)
      VALUES($1,$2,$3,$3,'본인 부담 기록',100,'SELECTED',100,0,$4,$4,$3,'KRW')`,
      [expenseId, id, owner.session.userId, now],
    );
    await client.query(
      'INSERT INTO expense_shares(expense_id,round_id,user_id,final_amount_minor,received_remainder) VALUES($1,$2,$3,100,false)',
      [expenseId, id, owner.session.userId],
    );
    for (const userId of [
      owner.session.userId,
      participant.session.userId,
      third.session.userId,
    ]) {
      const amount = userId === owner.session.userId ? '100' : '0';
      await client.query(
        "INSERT INTO settlement_balances(round_id,user_id,paid_minor,burden_minor,balance_minor,currency) VALUES($1,$2,$3,$3,0,'KRW')",
        [id, userId, amount],
      );
    }
    await client.query(
      "UPDATE rounds SET status='COMPLETED',confirmed_at=$2,locked_at=$2,finalized_at=$2,completed_at=$2 WHERE id=$1",
      [id, now],
    );
  });
  await withdrawAccount(participant.access);
  await assert.rejects(getAccount(participant.access), codeIs('unauthorized'));
  const withdrawn = await withReadTransaction(async (client) =>
    client.query(
      `
    SELECT u.deleted_at, m.left_at, (SELECT COUNT(*) FROM round_members rm WHERE rm.user_id=u.id) AS history_count
    FROM users u JOIN group_members m ON m.user_id=u.id WHERE u.id=$1 AND m.group_id=$2
  `,
      [participant.session.userId, group.id],
    ),
  );
  assert.notEqual(withdrawn.rows[0].deleted_at, null);
  assert.notEqual(withdrawn.rows[0].left_at, null);
  assert.equal(withdrawn.rows[0].history_count, '1');

  const returning = await signInKakao(participant.subject, profile);
  assert.equal(returning.purpose, 'onboarding');
  assert.equal(returning.userId, participant.session.userId);
  await assert.rejects(
    getAccount(accessOf(returning)),
    codeIs('onboarding_required'),
  );
  await assert.rejects(
    completeOnboarding(accessOf(returning), bank),
    codeIs('rejoin_confirmation_required'),
  );
  const restored = await completeOnboarding(accessOf(returning), {
    ...bank,
    confirmRejoin: true,
  });
  const restoredAccess = accessOf(restored);
  assert.equal(restored.userId, participant.session.userId);
  assert.equal(
    (await listGroups(restoredAccess, new URLSearchParams())).items.length,
    0,
  );
  await assert.rejects(getGroup(restoredAccess, group.id), codeIs('not_found'));
  assert.equal((await getAccount(participant.access)).id, restored.userId);
  const retained = await withReadTransaction((client) =>
    client.query('SELECT round_id FROM round_members WHERE user_id=$1', [
      restored.userId,
    ]),
  );
  assert.deepEqual(
    retained.rows.map((row) => row.round_id),
    [roundIds[1]],
  );
  assert.equal((await getInvite(restoredAccess, token)).isMember, false);
  await acceptInvite(restoredAccess, randomUUID(), token);
  assert.ok(
    (await getGroup(restoredAccess, group.id)).members.some(
      (member) => member.userId === restored.userId,
    ),
  );
  assert.equal((await getGroup(restoredAccess, group.id)).isCreator, false);

  await withdrawAccount(owner.access);
  const ownerReturning = await signInKakao(owner.subject, profile);
  const ownerRestored = await completeOnboarding(accessOf(ownerReturning), {
    ...bank,
    confirmRejoin: true,
  });
  await assert.rejects(
    getGroup(accessOf(ownerRestored), group.id),
    codeIs('not_found'),
  );
  await assert.rejects(
    getInvite(restoredAccess, token),
    codeIs('not_found'),
    'an inactive creator membership makes old invitations unusable',
  );
});

test('refresh JWTs can be reused without stored sessions and preserve onboarding purpose', async () => {
  const tokens = await testProvider(TokenService);
  const user = await newAccount();
  const refresh = readRefreshToken(user.session.refreshToken)!;
  for (let i = 0; i < 2; i++) {
    const renewed = readAccessToken(
      tokens.accessTokenForRefresh(refresh).accessToken,
    )!;
    assert.equal((await getAccount(renewed)).id, user.session.userId);
  }
  const stored = await withReadTransaction((client) =>
    client.query('SELECT COUNT(*) FROM refresh_sessions WHERE user_id=$1', [
      user.session.userId,
    ]),
  );
  assert.equal(
    stored.rows[0].count,
    '0',
    'login and onboarding never store JWT sessions',
  );
  await withdrawAccount(user.access);
  const renewed = readAccessToken(
    tokens.accessTokenForRefresh(refresh).accessToken,
  )!;
  await assert.rejects(getAccount(renewed), codeIs('unauthorized'));

  const limited = await signInKakao(`integration-${randomUUID()}`, profile);
  const limitedRefresh = readRefreshToken(limited.refreshToken)!;
  const limitedAccess = readAccessToken(
    tokens.accessTokenForRefresh(limitedRefresh).accessToken,
  )!;
  assert.equal(limitedAccess.purpose, 'onboarding');
  await assert.rejects(
    getAccount(limitedAccess),
    codeIs('onboarding_required'),
  );
  await completeOnboarding(limitedAccess, bank);
  await assert.rejects(getAccount(limitedAccess, true), codeIs('unauthorized'));
});

test('sign-in racing withdrawal cannot leave a API access for a deleted account', async () => {
  const user = await newAccount();
  const [login] = await Promise.all([
    signInKakao(user.subject, profile),
    withdrawAccount(user.access),
  ]);
  const state = await withReadTransaction((client) =>
    client.query(
      `
    SELECT u.deleted_at FROM users u WHERE u.id=$1
  `,
      [user.session.userId],
    ),
  );
  assert.notEqual(state.rows[0].deleted_at, null);
  await assert.rejects(
    getAccount(accessOf(login)),
    (error) =>
      error instanceof AppError &&
      ['unauthorized', 'onboarding_required'].includes(error.code),
  );
});

before(async () => {
  await getPrismaClient(process.env.TEST_DATABASE_URL!);
});
