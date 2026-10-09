import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import sharp from 'sharp';
import { createBackend } from '../../domain/main';
import { SettleService } from '../../domain/settle/service/settle.service';
import { createDatabaseClient } from '../../global/database/db';
import { readAccessToken } from '../support/legacyTokenTestSupport.ts';
import {
  acceptInvite,
  createGroup,
  createInvite,
  createRound,
  saveExpense,
  signInKakao,
} from '../support/domainTestSupport';
import { completeTestOnboarding } from './bankTestSupport';
import { drainReceiptQueue } from './receiptWorkerTestSupport';
import { applyMigrations } from '../../../../scripts/migrations.mjs';
import { uuidV7 } from '../../../shared/uuid';
import {
  MAX_RECEIPT_BYTES,
  MAX_RECEIPT_REQUEST_BYTES,
} from '../../../shared/domain/settle';

const url = process.env.TEST_DATABASE_URL;
if (
  !url ||
  !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname) ||
  !new URL(url).pathname.includes('test')
)
  throw new Error('An isolated local test database is required');
process.env.DATABASE_URL = url;

test('native Nest multipart preserves field/error/size/digest contracts and delivers one Buffer to the registered Service', async (t) => {
  const db = createDatabaseClient(url);
  await db.connect();
  t.after(() => db.end());
  await applyMigrations(db);
  const member = async () => {
    const session = await signInKakao(`receipt-multipart:${randomUUID()}`, {
      displayName: 'multipart',
      email: null,
      profileImageUrl: null,
    });
    return completeTestOnboarding(readAccessToken(session.accessToken), {
      bankName: '검증은행',
      accountNumber: '12340312345678',
      accountHolder: '업로드',
    });
  };
  const owner = await member(),
    other = await member();
  const access = readAccessToken(owner.accessToken)!;
  const group = await createGroup(access, uuidV7(), {
    name: 'native multipart',
  });
  const invite = await createInvite(access, randomUUID(), group.id, {});
  await acceptInvite(
    readAccessToken(other.accessToken),
    randomUUID(),
    invite.sharePath!.split('/').at(-1)!,
  );
  const round = await createRound(access, uuidV7(), group.id, {
    name: '업로드',
    participantIds: [owner.userId, other.userId],
  });
  const expense = await saveExpense(access, randomUUID(), round.id, {
    currency: 'KRW',
    description: 'AVIF',
    amount: '10',
    payerId: owner.userId,
    splitMode: 'ALL',
    expectedVersion: round.version,
  });
  const bytes = await sharp({
    create: { width: 2, height: 2, channels: 3, background: '#369' },
  })
    .avif()
    .toBuffer();
  const file = (name = '영수증.AVIF') =>
    new File([bytes], name, { type: 'image/avif' });
  const form = (version = String(expense.version)) => {
    const data = new FormData();
    data.set('file', file());
    data.set('expectedVersion', version);
    return data;
  };
  const { app } = await createBackend();
  t.after(() => app.close());
  await app.listen(0, '127.0.0.1');
  const origin = await app.getUrl();
  const path = `/api/rounds/${round.id}/expenses/${expense.id}/receipts`;
  const documented = await fetch(`${origin}/api/openapi.json`, {
    headers: { authorization: `Bearer ${owner.accessToken}` },
  });
  assert.equal(documented.status, 200);
  const api = await documented.json();
  const content =
    api.paths['/api/rounds/{roundId}/expenses/{expenseId}/receipts'].post
      .requestBody.content;
  assert.deepEqual(Object.keys(content), ['multipart/form-data']);
  const schema = api.components.schemas.ReceiptUploadRequestDTO;
  assert.deepEqual(schema.required, ['file', 'expectedVersion']);
  assert.equal(schema.properties.file.format, 'binary');
  assert.equal(schema.properties.expectedVersion.type, 'integer');
  const service = app.get(SettleService);
  const original = service.saveReceipt.bind(service);
  let calls = 0;
  t.mock.method(
    service,
    'saveReceipt',
    async (...args: Parameters<SettleService['saveReceipt']>) => {
      calls++;
      assert.ok(Number.isSafeInteger(args[1].expectedVersion));
      assert.ok(
        Buffer.isBuffer(args[1].bytes),
        'Multer Buffer reaches the registered Service without Web Request/File round trips',
      );
      assert.ok(
        ['영수증.AVIF', '한글 경로/영수증.AVIF'].includes(args[1].name!),
        'native parser preserves the full UTF-8 filename',
      );
      return original(...args);
    },
  );
  const headers = (key = randomUUID()) => ({
    origin,
    authorization: `Bearer ${owner.accessToken}`,
    'idempotency-key': key,
  });
  const request = (
    body: FormData | string,
    extra: Record<string, string> = {},
    key = randomUUID(),
  ) =>
    fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { ...headers(key), ...extra },
      body,
      signal: AbortSignal.timeout(10000),
    });
  const reject = async (
    body: FormData | string,
    message: string,
    extra: Record<string, string> = {},
    code = 'invalid_input',
  ) => {
    const previous = calls;
    const response = await request(body, extra);
    const payload = await response.json();
    assert.equal(response.status, 400, JSON.stringify(payload));
    assert.equal(payload.error, code);
    assert.equal(payload.message, message);
    assert.equal(payload.detail, null);
    assert.equal(
      calls,
      previous,
      'native parser/DTO rejection occurs before persistence',
    );
  };
  const shape = '이미지를 한 개씩 올려 주세요';
  const malformed = '영수증 업로드 형식을 확인해 주세요';
  await reject('malformed', malformed, {
    'content-type': 'multipart/form-data',
  });
  await reject('--broken\r\n', malformed, {
    'content-type': 'multipart/form-data; boundary=broken',
  });
  await reject('{}', malformed, { 'content-type': 'application/json' });
  await reject(new FormData(), shape);
  const missingFile = form();
  missingFile.delete('file');
  await reject(missingFile, shape);
  const missingVersion = form();
  missingVersion.delete('expectedVersion');
  await reject(missingVersion, shape);
  const duplicateFile = form();
  duplicateFile.append('file', file());
  await reject(duplicateFile, shape);
  const duplicateVersion = form();
  duplicateVersion.append('expectedVersion', '2');
  await reject(duplicateVersion, shape);
  const extraField = form();
  extraField.set('extra', 'unknown');
  await reject(extraField, shape);
  for (const field of [
    'file',
    '__proto__',
    'expectedVersion[x]',
    'expectedVersion[]',
  ]) {
    const invalid = new FormData();
    invalid.set('file', file());
    invalid.set(field, '2');
    await reject(invalid, shape);
  }
  for (const version of ['', '0', '1.5', 'not-a-number', '9007199254740992'])
    await reject(
      form(version),
      '회차 버전이 필요합니다',
      {},
      'invalid_version',
    );

  const raw = async (body: Buffer, contentType: string, key = randomUUID()) =>
    new Promise<Response>((resolve, reject) => {
      const request = httpRequest(
        `${origin}${path}`,
        {
          method: 'POST',
          headers: {
            ...headers(key),
            'content-type': contentType,
            'transfer-encoding': 'chunked',
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          response.on('error', reject);
          response.on('end', () =>
            resolve(
              new Response(Buffer.concat(chunks), {
                status: response.statusCode,
                headers: response.headers as Record<string, string>,
              }),
            ),
          );
        },
      );
      request.on('error', reject);
      request.setTimeout(10000, () =>
        request.destroy(new Error('Chunked upload timed out')),
      );
      // Deliberately omit Content-Length and split framing independently of multipart parts.
      for (let offset = 0; offset < body.length; offset += 32768)
        request.write(body.subarray(offset, offset + 32768));
      request.end();
    });
  const encoded = new Request('http://localhost', {
    method: 'POST',
    body: form(),
  });
  const encodedBytes = Buffer.from(await encoded.arrayBuffer());
  const contentType = encoded.headers.get('content-type')!;
  const padding = Buffer.concat([
    Buffer.alloc(MAX_RECEIPT_REQUEST_BYTES, ' '),
    Buffer.from('\r\n'),
    encodedBytes,
  ]);
  const totalOverflow = await raw(padding, contentType);
  assert.equal(totalOverflow.status, 413, await totalOverflow.clone().text());
  assert.deepEqual(await totalOverflow.json(), {
    error: 'receipt_too_large',
    code: 'receipt_too_large',
    detail: null,
    message: '요청 크기가 너무 커요',
  });
  const tooLarge = form();
  tooLarge.set(
    'file',
    new File([Buffer.alloc(MAX_RECEIPT_BYTES + 1)], 'large.avif', {
      type: 'image/avif',
    }),
  );
  const encodedLarge = new Request('http://localhost', {
    method: 'POST',
    body: tooLarge,
  });
  const fileOverflow = await raw(
    Buffer.from(await encodedLarge.arrayBuffer()),
    encodedLarge.headers.get('content-type')!,
  );
  assert.equal(fileOverflow.status, 413, await fileOverflow.clone().text());
  assert.deepEqual(await fileOverflow.json(), {
    error: 'receipt_too_large',
    code: 'receipt_too_large',
    detail: null,
    message: '영수증 파일은 10MB 이하로 올려 주세요',
  });
  assert.equal(calls, 0);

  const key = randomUUID();
  const accepted = await request(
    form(` 0x${expense.version!.toString(16)} `),
    {},
    key,
  );
  assert.equal(accepted.status, 202, await accepted.clone().text());
  const result = (await accepted.json()).data;
  for (const version of [String(expense.version), `${expense.version}e0`]) {
    const replay = await request(form(version), {}, key);
    assert.equal(replay.status, 202, await replay.clone().text());
    assert.deepEqual((await replay.json()).data, result);
  }
  const names = form();
  names.set('file', file('한글 경로/영수증.AVIF'));
  const renamedReplay = await request(names, {}, key);
  assert.equal(
    renamedReplay.status,
    202,
    'filename does not enter the digest and UTF-8/full path retains the AVIF extension',
  );
  await renamedReplay.arrayBuffer();
  await drainReceiptQueue();
  const persisted = await db.query(
    'SELECT byte_size,storage_status FROM expense_receipts WHERE id=$1',
    [result.id],
  );
  assert.equal(persisted.rows[0].byte_size, bytes.length);
  assert.equal(persisted.rows[0].storage_status, 'READY');
  const conflicts = await request(form(String(expense.version! + 1)), {}, key);
  assert.equal(conflicts.status, 409);
  assert.equal((await conflicts.json()).code, 'idempotency_conflict');
});
