import { ReceiptStorage } from '../../global/util/minio.util';
import { ReceiptWorker } from '../../domain/settle/service/receiptWorker';
import { SettleRepository } from '../../domain/settle/repository/settle.repository';
import { AccountStateRepository } from '../../domain/user/repository/accountState.repository';
import type { Database } from '../../global/database/db';
import type { INestApplication } from '@nestjs/common';
import { channel } from 'node:diagnostics_channel';
import { before, after } from 'node:test';
import { createBackend } from '../../domain/main';
import { AuthService } from '../../global/auth/service/auth.service';
import { disconnectPrismaClients } from '../../global/database/prisma.service';
import { PrismaService } from '../../global/database/prisma.service';
import { closeDatabasePools } from '../../global/database/dbClient.mjs';
import { drainReceiptQueue } from './receiptWorkerTestSupport';
import { uuidV7 } from '../../../shared/uuid.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import sharp from 'sharp';
import { readAccessToken } from '../../global/auth/native.ts';
import { createDatabaseClient } from '../../global/database/db.ts';
import { CURRENCY_CODES } from '../../../shared/domain/settle/money.ts';

const me = (req: Request) => fetch(req.url, { headers: req.headers });
import { applyMigrations } from '../../../../scripts/migrations.mjs';

const testUrl = process.env.TEST_DATABASE_URL;
if (
  !testUrl ||
  !['localhost', '127.0.0.1', '[::1]'].includes(new URL(testUrl).hostname) ||
  !new URL(testUrl).pathname.toLowerCase().includes('test')
)
  throw new Error(
    'TEST_DATABASE_URL must name an isolated local test database',
  );
process.env.DATABASE_URL = testUrl;
process.env.AUTH_JWT_SECRET ||=
  'integration-only-not-a-production-secret-0123456789';
let origin: string;
let app: INestApplication;

async function session(name: string) {
  const signup = await app
    .get(AuthService)
    .signInKakao(`routes-test:${randomUUID()}`, {
      displayName: name,
      email: null,
      profileImageUrl: null,
    });
  const result = await request('me/onboarding', signup.accessToken, 'POST', {
    bankCode: '004',
    accountNumber: '12340312345678',
    accountHolder: name,
    expectedBankVersion: 0,
    confirmRejoin: false,
  });
  assert.equal(result.status, 200, await result.clone().text());
  assert.ok(result.headers.getSetCookie().length >= 2);
  const body = await result.json();
  return { userId: signup.userId, accessToken: body.data.accessToken };
}

async function request(
  path: string,
  token: string | null,
  method = 'GET',
  body?: unknown,
  extraHeaders?: Record<string, string>,
) {
  const headers = new Headers({ origin, ...extraHeaders });
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (method !== 'GET' && !headers.has('Idempotency-Key'))
    headers.set(
      'Idempotency-Key',
      method === 'POST' &&
        (path === 'groups' || /^groups\/[^/]+\/rounds$/.test(path))
        ? uuidV7()
        : randomUUID(),
    );
  const multipart = body instanceof FormData;
  if (body !== undefined && !multipart)
    headers.set('content-type', 'application/json');
  const response = await fetch(`${origin}/api/${path}`, {
    method,
    headers,
    ...(body === undefined
      ? {}
      : { body: multipart ? (body as FormData) : JSON.stringify(body) }),
  });
  return response;
}

test('Actual Nest HTTP plus real PostgreSQL contracts enforce Bearer JWTs, origin, idempotency, normalized images and personalized output', async (t) => {
  const storage = t.mock.method(app.get(ReceiptStorage), 'putReceipt');
  const repository = t.mock.method(
    app.get(SettleRepository),
    'finishReceiptStorage',
  );
  t.after(() => {
    assert.ok(
      storage.mock.callCount() > 0,
      'queued uploads use the registered storage Provider',
    );
    assert.ok(
      repository.mock.callCount() > 0,
      'queued completion uses the registered repository Provider',
    );
  });
  const client = createDatabaseClient(testUrl);
  await client.connect();
  try {
    await applyMigrations(client);
    const a = await session('API-A'),
      b = await session('API-B'),
      outsider = await session('API-외부인');
    assert.equal((await request('groups', null)).status, 401);
    assert.equal(
      (
        await request(
          'groups',
          a.accessToken,
          'POST',
          { name: '금지' },
          { origin: 'https://attacker.example' },
        )
      ).status,
      403,
    );
    const account = await me(
      new Request(`${origin}/api/me`, {
        headers: { authorization: `Bearer ${a.accessToken}` },
      }),
    );
    assert.equal(account.headers.get('cache-control'), 'private, no-store');
    assert.equal(
      (await account.json()).data.bankAccount.accountNumber,
      '12340312345678',
    );
    const groupResult = await request('groups', a.accessToken, 'POST', {
      name: 'HTTP 계약',
    });
    assert.equal(groupResult.status, 200, await groupResult.clone().text());
    const groupPayload = await groupResult.json();
    assert.deepEqual(Object.keys(groupPayload).sort(), ['data', 'meta']);
    assert.equal(groupPayload.meta.code, 'group_ok');
    assert.equal(groupPayload.meta.detail, null);
    assert.equal(typeof groupPayload.meta.message, 'string');
    const groupId = groupPayload.data.id;
    const emptyGroup = await request('groups', a.accessToken, 'POST', {
      name: '삭제 API 계약',
    });
    const emptyGroupId = (await emptyGroup.json()).data.id;
    assert.equal(
      (await request(`groups/${emptyGroupId}`, a.accessToken, 'DELETE')).status,
      200,
    );
    assert.equal(
      (await request(`groups/${emptyGroupId}`, a.accessToken)).status,
      404,
    );
    const detail = (
      await (await request(`groups/${groupId}`, a.accessToken)).json()
    ).data;
    assert.equal('currency' in detail, false);
    assert.deepEqual(detail.members, [
      { userId: a.userId, displayName: 'API-A', excludedAt: null },
    ]);
    assert.equal(detail.isCreator, true);
    assert.equal((await request(`groups/${groupId}`, null)).status, 401);
    assert.equal(
      (await request(`groups/${groupId}`, outsider.accessToken)).status,
      404,
    );
    assert.equal(
      (await request(`groups/${groupId}/members`, a.accessToken)).status,
      404,
    );
    const invite = (
      await (
        await request(`groups/${groupId}/invites`, a.accessToken, 'POST', {})
      ).json()
    ).data;
    const token = invite.sharePath.split('/').at(-1);
    const preview = (
      await (await request(`invites/${token}`, b.accessToken)).json()
    ).data;
    assert.equal(preview.isMember, false);
    assert.equal('currency' in preview, false);
    assert.equal(
      (await request(`invites/${token}/accept`, b.accessToken, 'POST')).status,
      200,
    );
    const participantDetail = (
      await (await request(`groups/${groupId}`, b.accessToken)).json()
    ).data;
    assert.deepEqual(
      participantDetail.members.map(
        (member: { userId: string }) => member.userId,
      ),
      [a.userId, b.userId],
    );
    assert.equal(participantDetail.isCreator, false);
    assert.deepEqual(participantDetail.invites, []);
    const memberCreated = await request(
      `groups/${groupId}/rounds`,
      b.accessToken,
      'POST',
      { name: '참여자가 만든 회차', participantIds: [a.userId, b.userId] },
    );
    assert.equal(memberCreated.status, 200);
    const memberRoundId = (await memberCreated.json()).data.id;
    const memberRound = (
      await (await request(`rounds/${memberRoundId}`, b.accessToken)).json()
    ).data;
    assert.equal(memberRound.creatorId, b.userId);
    assert.equal(memberRound.groupCreatorId, a.userId);
    assert.equal(memberRound.isCreator, true);
    assert.equal(
      (
        await request(`rounds/${memberRoundId}`, b.accessToken, 'DELETE', {
          expectedVersion: 1,
        })
      ).status,
      200,
    );
    const ticket = uuidV7(),
      body = { name: 'API 회차', participantIds: [a.userId, b.userId] };
    const created = await request(
      `groups/${groupId}/rounds`,
      a.accessToken,
      'POST',
      body,
      { 'Idempotency-Key': ticket },
    );
    assert.equal(created.status, 200);
    const roundId = (await created.json()).data.id;
    assert.equal(roundId, ticket);
    const duplicate = await request(
      `groups/${groupId}/rounds`,
      a.accessToken,
      'POST',
      body,
      { 'Idempotency-Key': ticket },
    );
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).error, 'round_already_exists');
    for (const currency of CURRENCY_CODES) {
      const foreign = await request(
        `groups/${groupId}/rounds`,
        a.accessToken,
        'POST',
        { name: `${currency} API 회차`, participantIds: [a.userId, b.userId] },
      );
      assert.equal(foreign.status, 200);
      const foreignId = (await foreign.json()).data.id;
      const saved = await request(
        `rounds/${foreignId}/expenses`,
        a.accessToken,
        'POST',
        {
          currency: currency,
          description: '회차 통화',
          amount: ['KRW', 'JPY', 'VND'].includes(currency) ? '1025' : '10.25',
          payerId: b.userId,
          splitMode: 'ALL',
          expectedVersion: 1,
        },
      );
      assert.equal(saved.status, 200);
      const current = (
        await (await request(`rounds/${foreignId}`, a.accessToken)).json()
      ).data;
      assert.equal(current.groupId, groupId);
      assert.equal(current.expenses[0].currency, currency);
      assert.equal(current.expenses[0].amountMinor, '1025');
    }
    assert.equal(
      'currency' in
        (await (await request(`rounds/${roundId}`, a.accessToken)).json()).data,
      false,
    );
    for (const currency of [undefined, 'XXX']) {
      const rejected = await request(
        `rounds/${roundId}/expenses`,
        a.accessToken,
        'POST',
        {
          description: '통화 필요',
          amount: '10',
          payerId: a.userId,
          splitMode: 'ALL',
          expectedVersion: 1,
          ...(currency === undefined ? {} : { currency }),
        },
      );
      assert.equal(rejected.status, 400);
      assert.equal((await rejected.json()).error, 'unsupported_currency');
    }
    const customRound = (
      await (
        await request(`groups/${groupId}/rounds`, a.accessToken, 'POST', {
          name: '개별 부담 API',
          participantIds: [a.userId, b.userId],
        })
      ).json()
    ).data;
    const customBody = {
      currency: 'USD',
      description: '개별 지출',
      amount: '0.30',
      payerId: b.userId,
      splitMode: 'CUSTOM',
      customShares: [
        { userId: a.userId, amount: '0.10' },
        { userId: b.userId, amount: '0.20' },
      ],
      expectedVersion: 1,
    };
    const mismatch = await request(
      `rounds/${customRound.id}/expenses`,
      a.accessToken,
      'POST',
      { ...customBody, amount: '0.31' },
    );
    assert.equal(mismatch.status, 400);
    assert.deepEqual(await mismatch.json(), {
      error: 'custom_share_total_mismatch',
      code: 'custom_share_total_mismatch',
      detail: null,
      message: '부담금 합계가 총 금액과 일치해야 해요',
    });
    const customSave = await request(
      `rounds/${customRound.id}/expenses`,
      a.accessToken,
      'POST',
      customBody,
    );
    assert.equal(customSave.status, 200, await customSave.clone().text());
    const customExpense = (await customSave.json()).data;
    const customPatch = await request(
      `rounds/${customRound.id}/expenses/${customExpense.id}`,
      a.accessToken,
      'PATCH',
      { amount: '0.40', expectedVersion: customExpense.version },
    );
    assert.equal(customPatch.status, 400);
    assert.equal(
      (await customPatch.json()).error,
      'custom_share_total_mismatch',
    );
    const customDetail = (
      await (await request(`rounds/${customRound.id}`, a.accessToken)).json()
    ).data;
    assert.equal(customDetail.version, customExpense.version);
    assert.equal(customDetail.expenses[0].amountMinor, '30');
    assert.deepEqual(
      Object.fromEntries(
        customDetail.expenses[0].shares.map(
          (share: { userId: string; assignedAmountMinor: string }) => [
            share.userId,
            share.assignedAmountMinor,
          ],
        ),
      ),
      { [a.userId]: '10', [b.userId]: '20' },
    );
    assert.ok(
      customDetail.expenses[0].shares.every(
        (share: { amountMinor: string | null }) => share.amountMinor === null,
      ),
    );
    const absent = await request(`rounds/${roundId}`, outsider.accessToken);
    assert.equal(absent.status, 404);
    assert.equal(
      (
        await request(`rounds/${roundId}/confirm`, a.accessToken, 'POST', {
          expectedVersion: 1,
        })
      ).status,
      409,
    );
    const invalid = await request(
      `rounds/${roundId}/expenses`,
      a.accessToken,
      'POST',
      {
        currency: 'KRW',
        description: '잘못된금액',
        amount: 6000,
        payerId: b.userId,
        splitMode: 'ALL',
        expectedVersion: 1,
      },
    );
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, 'invalid_amount');
    const requestKey = randomUUID(),
      expenseBody = {
        currency: 'KRW',
        description: '식사',
        amount: '6000',
        payerId: b.userId,
        splitMode: 'ALL',
        expectedVersion: 1,
      };
    const save = await request(
      `rounds/${roundId}/expenses`,
      a.accessToken,
      'POST',
      expenseBody,
      { 'Idempotency-Key': requestKey },
    );
    const e = (await save.json()).data;
    const replay = await request(
      `rounds/${roundId}/expenses`,
      a.accessToken,
      'POST',
      expenseBody,
      { 'Idempotency-Key': requestKey },
    );
    assert.deepEqual((await replay.json()).data, e);
    assert.equal(
      (
        await request(
          `rounds/${roundId}/expenses/${e.id}/receipts`,
          null,
          'POST',
          {},
        )
      ).status,
      401,
    );
    const form = new FormData();
    const avif = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#369' },
    })
      .avif()
      .toBuffer();
    form.set('file', new File([avif], 'receipt.avif', { type: 'image/avif' }));
    form.set('expectedVersion', String(e.version));
    const uploaded = await request(
      `rounds/${roundId}/expenses/${e.id}/receipts`,
      a.accessToken,
      'POST',
      form,
    );
    assert.equal(uploaded.status, 202);
    const receipt = (await uploaded.json()).data;
    await drainReceiptQueue(app.get(ReceiptWorker));
    const binary = await request(`receipts/${receipt.id}`, b.accessToken);
    assert.equal(binary.headers.get('content-type'), 'image/avif');
    assert.equal(binary.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(binary.headers.get('cache-control'), 'private, no-store');
    const converted = Buffer.from(await binary.arrayBuffer());
    assert.equal((await sharp(converted).metadata()).mediaType, 'image/avif');
    assert.deepEqual(converted, avif);
    assert.equal(
      (await request(`receipts/${receipt.id}`, outsider.accessToken)).status,
      404,
    );
    const largeAvif = Buffer.alloc(10 * 1024 * 1024);
    avif.copy(largeAvif);
    largeAvif.writeUInt32BE(largeAvif.length - avif.length, avif.length);
    largeAvif.write('free', avif.length + 4, 'ascii');
    const largeForm = new FormData();
    largeForm.set(
      'file',
      new File([largeAvif], 'large.avif', { type: 'image/avif' }),
    );
    largeForm.set('expectedVersion', String(receipt.version));
    const largeUpload = await request(
      `rounds/${roundId}/expenses/${e.id}/receipts`,
      a.accessToken,
      'POST',
      largeForm,
    );
    assert.equal(largeUpload.status, 202, await largeUpload.clone().text());
    const largeReceipt = (await largeUpload.json()).data;
    await drainReceiptQueue(app.get(ReceiptWorker));
    const largeBinary = await request(
      `receipts/${largeReceipt.id}`,
      b.accessToken,
    );
    assert.equal(largeBinary.headers.get('content-type'), 'image/avif');
    assert.deepEqual(Buffer.from(await largeBinary.arrayBuffer()), largeAvif);
    largeForm.set('expectedVersion', String(largeReceipt.version));
    largeForm.set(
      'file',
      new File([Buffer.alloc(10 * 1024 * 1024 + 1)], 'too-large.avif', {
        type: 'image/avif',
      }),
    );
    const tooLarge = await request(
      `rounds/${roundId}/expenses/${e.id}/receipts`,
      a.accessToken,
      'POST',
      largeForm,
    );
    assert.equal(tooLarge.status, 413);
    assert.equal((await tooLarge.json()).error, 'receipt_too_large');
    largeForm.set(
      'file',
      new File(
        [Buffer.alloc(10 * 1024 * 1024 + 65536)],
        'too-large-body.avif',
        { type: 'image/avif' },
      ),
    );
    assert.equal(
      (
        await request(
          `rounds/${roundId}/expenses/${e.id}/receipts`,
          a.accessToken,
          'POST',
          largeForm,
        )
      ).status,
      413,
    );
    const confirmed = (
      await (
        await request(`rounds/${roundId}/confirm`, a.accessToken, 'POST', {
          expectedVersion: largeReceipt.version,
        })
      ).json()
    ).data;
    const sent = await request(
      `rounds/${roundId}/send`,
      a.accessToken,
      'POST',
      { expectedVersion: confirmed.version },
    );
    assert.equal(sent.status, 200);
    const locked = (await sent.json()).data;
    const settlement = await request(
      `rounds/${roundId}/settlement?userId=${b.userId}`,
      a.accessToken,
    );
    assert.equal(settlement.headers.get('cache-control'), 'private, no-store');
    const result = (await settlement.json()).data;
    assert.equal(result.balances[0].balanceMinor, '3000');
    assert.equal(result.outgoing[0].receiverId, b.userId);
    assert.equal(result.outgoing[0].account.accountNumber, '12340312345678');
    assert.equal(result.incoming.length, 0);
    assert.equal(result.sharePath, `/settlements/${roundId}`);
    assert.equal(
      (
        await request(
          `rounds/${roundId}/settlement-check`,
          a.accessToken,
          'POST',
          { expectedVersion: locked.version, checked: 'yes' },
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await request(
          `rounds/${roundId}/settlement-check`,
          a.accessToken,
          'POST',
          { expectedVersion: locked.version, checked: true },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          `rounds/${roundId}/settlement-check`,
          b.accessToken,
          'POST',
          {
            expectedVersion: locked.version,
            checked: true,
            currency: 'KRW',
            senderId: a.userId,
          },
        )
      ).status,
      200,
    );
    const repeatedCheck = await request(
      `rounds/${roundId}/settlement-check`,
      b.accessToken,
      'POST',
      {
        expectedVersion: locked.version,
        checked: true,
        currency: 'KRW',
        senderId: a.userId,
      },
    );
    assert.equal(repeatedCheck.status, 404);
    assert.equal((await repeatedCheck.json()).error, 'not_found');
    const checked = (
      await (
        await request(`rounds/${roundId}/settlement`, a.accessToken)
      ).json()
    ).data;
    assert.deepEqual(
      {
        checkedCount: checked.checkedCount,
        requiredCount: checked.requiredCount,
        allChecked: checked.allChecked,
      },
      { checkedCount: 1, requiredCount: 1, allChecked: true },
    );
    assert.equal(
      (
        await request(`rounds/${roundId}/complete`, a.accessToken, 'POST', {
          expectedVersion: locked.version,
        })
      ).status,
      200,
    );
    const drawRound = (
      await (
        await request(`groups/${groupId}/rounds`, b.accessToken, 'POST', {
          name: '추첨 API 계약',
          participantIds: [a.userId, b.userId],
        })
      ).json()
    ).data;
    const drawExpense = (
      await (
        await request(
          `rounds/${drawRound.id}/expenses`,
          b.accessToken,
          'POST',
          {
            currency: 'KRW',
            description: '나머지',
            amount: '3',
            payerId: a.userId,
            splitMode: 'ALL',
            expectedVersion: drawRound.version,
          },
        )
      ).json()
    ).data;
    const drawConfirm = (
      await (
        await request(`rounds/${drawRound.id}/confirm`, b.accessToken, 'POST', {
          expectedVersion: drawExpense.version,
        })
      ).json()
    ).data;
    const drawLocked = (
      await (
        await request(`rounds/${drawRound.id}/send`, b.accessToken, 'POST', {
          expectedVersion: drawConfirm.version,
        })
      ).json()
    ).data;
    const drawPath = `rounds/${drawRound.id}/draw`,
      drawBody = { expectedVersion: drawLocked.version },
      drawKey = randomUUID();
    assert.equal(
      (await request(drawPath, a.accessToken, 'POST', drawBody)).status,
      403,
      'only the round creator may draw',
    );
    assert.equal(
      (await request(drawPath, outsider.accessToken, 'POST', drawBody)).status,
      404,
    );
    const drawn = await request(drawPath, b.accessToken, 'POST', drawBody, {
      'idempotency-key': drawKey,
    });
    assert.equal(drawn.status, 200, await drawn.clone().text());
    const drawResult = (await drawn.json()).data;
    assert.deepEqual(drawResult, {
      id: drawRound.id,
      roundId: drawRound.id,
      status: 'LOCKED',
      version: drawLocked.version + 1,
    });
    for (const ticket of [drawKey, randomUUID()]) {
      assert.deepEqual(
        (
          await (
            await request(drawPath, b.accessToken, 'POST', drawBody, {
              'idempotency-key': ticket,
            })
          ).json()
        ).data,
        drawResult,
      );
    }
    assert.equal(
      (
        await request(
          drawPath,
          b.accessToken,
          'POST',
          { expectedVersion: drawResult.version },
          { 'idempotency-key': drawKey },
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await (
          await request(`rounds/${drawRound.id}/settlement`, b.accessToken)
        ).json()
      ).data.finalized,
      true,
    );
    assert.equal(
      (await request(`invites/${token}/accept`, outsider.accessToken, 'POST'))
        .status,
      200,
    );
    const exclusionRound = (
      await (
        await request(`groups/${groupId}/rounds`, b.accessToken, 'POST', {
          name: '제외 API 계약',
          participantIds: [a.userId, b.userId, outsider.userId],
        })
      ).json()
    ).data;
    const exclusionPath = `rounds/${exclusionRound.id}/members/${a.userId}/exclude`;
    assert.equal(
      (
        await request(exclusionPath, a.accessToken, 'POST', {
          expectedVersion: 1,
        })
      ).status,
      403,
      'group creator cannot exclude in another member’s round',
    );
    const exclusionKey = randomUUID();
    const exclusion = await request(
      exclusionPath,
      b.accessToken,
      'POST',
      { expectedVersion: 1 },
      { 'Idempotency-Key': exclusionKey },
    );
    assert.equal(exclusion.status, 200);
    assert.deepEqual((await exclusion.json()).data, {
      roundId: exclusionRound.id,
      status: 'RECORDING',
      version: 2,
    });
    for (const ticket of [exclusionKey, randomUUID()]) {
      const repeated = await request(
        exclusionPath,
        b.accessToken,
        'POST',
        { expectedVersion: 1 },
        { 'Idempotency-Key': ticket },
      );
      assert.equal(repeated.status, 404);
      assert.equal((await repeated.json()).error, 'not_found');
    }
    const reopeningExpense = (
      await (
        await request(
          `rounds/${exclusionRound.id}/expenses`,
          b.accessToken,
          'POST',
          {
            currency: 'KRW',
            description: '재오픈 검증',
            amount: '3',
            payerId: b.userId,
            splitMode: 'ALL',
            expectedVersion: 2,
          },
        )
      ).json()
    ).data;
    const reopeningConfirmed = (
      await (
        await request(
          `rounds/${exclusionRound.id}/confirm`,
          b.accessToken,
          'POST',
          { expectedVersion: reopeningExpense.version },
        )
      ).json()
    ).data;
    const reopeningPath = `rounds/${exclusionRound.id}/reopen`,
      reopeningBody = { expectedVersion: reopeningConfirmed.version },
      reopeningKey = randomUUID();
    assert.equal(
      (await request(reopeningPath, a.accessToken, 'POST', reopeningBody))
        .status,
      403,
      'group creator cannot reopen another member’s round',
    );
    const reopened = await request(
      reopeningPath,
      b.accessToken,
      'POST',
      reopeningBody,
      { 'Idempotency-Key': reopeningKey },
    );
    assert.equal(reopened.status, 200);
    assert.deepEqual((await reopened.json()).data, {
      id: exclusionRound.id,
      roundId: exclusionRound.id,
      status: 'RECORDING',
      version: reopeningConfirmed.version + 1,
    });
    for (const ticket of [reopeningKey, randomUUID()]) {
      const repeated = await request(
        reopeningPath,
        b.accessToken,
        'POST',
        reopeningBody,
        { 'Idempotency-Key': ticket },
      );
      assert.equal(repeated.status, 409);
      assert.equal((await repeated.json()).error, 'invalid_round_state');
    }
    const completedReopen = await request(
      `rounds/${roundId}/reopen`,
      a.accessToken,
      'POST',
      { expectedVersion: locked.version + 1 },
    );
    assert.equal(completedReopen.status, 409);
    assert.equal((await completedReopen.json()).error, 'invalid_round_state');
    assert.equal(
      (await request('unknown/endpoint', a.accessToken)).status,
      404,
    );
  } finally {
    await client.end();
  }
});

test('Nest rejects invalid DTOs without querying PostgreSQL', async () => {
  const actor = await session('DTO 경계');
  let queries = 0;
  const count = () => queries++;
  const observer = channel('da-moa.db.query');
  observer.subscribe(count);
  try {
    assert.equal(
      (await request('groups?limit=abc', actor.accessToken)).status,
      400,
    );
    assert.equal(
      (
        await request('groups', actor.accessToken, 'POST', {
          name: '필드 검사',
          unexpected: true,
        })
      ).status,
      400,
    );
    assert.equal(queries, 0);
  } finally {
    observer.unsubscribe(count);
  }
});

test('Nest HTTP expense failure rolls back the expense, version and replay metadata', async (t) => {
  const actor = await session('롤백-A');
  const member = await session('롤백-B');
  const group = await request('groups', actor.accessToken, 'POST', {
    name: 'HTTP 롤백',
  });
  const groupId = (await group.json()).data.id;
  const invite = await request(
    `groups/${groupId}/invites`,
    actor.accessToken,
    'POST',
    {},
  );
  const token = (await invite.json()).data.sharePath.split('/').at(-1);
  assert.equal(
    (await request(`invites/${token}/accept`, member.accessToken, 'POST'))
      .status,
    200,
  );
  const round = await request(
    `groups/${groupId}/rounds`,
    actor.accessToken,
    'POST',
    {
      name: '롤백 회차',
      participantIds: [actor.userId, member.userId],
    },
  );
  const roundId = (await round.json()).data.id;
  const client = createDatabaseClient(testUrl);
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT format('ALTER TABLE mutation_requests ADD CONSTRAINT nest_http_reject_mutation
        CHECK (NOT (actor_id = %L AND operation = ''expense.create''))', $1::text) AS ddl`,
      [actor.userId],
    );
    await client.query(rows[0].ddl);
    const logger = t.mock.method(console, 'error', () => {});
    const failed = await request(
      `rounds/${roundId}/expenses`,
      actor.accessToken,
      'POST',
      {
        currency: 'KRW',
        description: '실패한 저장',
        amount: '1000',
        payerId: actor.userId,
        splitMode: 'ALL',
        expectedVersion: 1,
      },
    );
    assert.equal(failed.status, 503);
    assert.ok(logger.mock.callCount() > 0);
    const prisma = app.get(PrismaService).client;
    assert.equal(
      await prisma.expenses.count({ where: { round_id: roundId } }),
      0,
    );
    assert.equal(
      (await prisma.rounds.findUniqueOrThrow({ where: { id: roundId } }))
        .version,
      1,
    );
    assert.equal(
      await prisma.mutation_requests.count({
        where: { actor_id: actor.userId, operation: 'expense.create' },
      }),
      0,
    );
  } finally {
    await client.query(
      'ALTER TABLE mutation_requests DROP CONSTRAINT IF EXISTS nest_http_reject_mutation',
    );
    await client.end();
  }
});

before(async () => {
  ({ app } = await createBackend());
  await app.listen(0, '127.0.0.1');
  origin = await app.getUrl();
});
after(async () => {
  await app?.close();
  await disconnectPrismaClients();
  await closeDatabasePools();
});

test('Nest HTTP uses the registered account Provider and retains transaction context', async (t) => {
  const actor = await session('DI 검증');
  const accounts = app.get(AccountStateRepository);
  const blocked = t.mock.method(accounts, 'findState', async () => null);
  assert.equal((await request('me', actor.accessToken)).status, 401);
  assert.equal(
    (await request('groups', actor.accessToken, 'POST', { name: 'DI 차단' }))
      .status,
    401,
  );
  assert.equal(blocked.mock.callCount(), 2);
  blocked.mock.restore();

  const contexts: Database[] = [];
  const original = accounts.findState.bind(accounts);
  const observed = t.mock.method(
    accounts,
    'findState',
    async (client: Database, id: string) => {
      contexts.push(client);
      return original(client, id);
    },
  );
  const previousLog = process.env.DB_QUERY_LOG;
  process.env.DB_QUERY_LOG = 'true';
  t.after(() => {
    if (previousLog === undefined) delete process.env.DB_QUERY_LOG;
    else process.env.DB_QUERY_LOG = previousLog;
  });
  const statements: string[] = [];
  t.mock.method(console, 'info', (message: string) =>
    statements.push(message.replace(/\s+/g, ' ')),
  );
  const result = await request('auth/withdraw', actor.accessToken, 'POST');
  assert.equal(result.status, 200, await result.clone().text());
  assert.equal(contexts.length, 1);
  assert.equal(
    statements.filter((sql) => /FROM "public"\."users"/.test(sql)).length,
    1,
    'one AUTH SELECT per request',
  );
  assert.notEqual(
    contexts[0].prisma,
    app.get(PrismaService).client,
    'authorization must use the write transaction client',
  );
  observed.mock.restore();
});
