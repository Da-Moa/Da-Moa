import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { uuidV4, uuidV7 } from '../../../shared/uuid';
import { isUUID } from 'class-validator';
import { mutationDigest } from '../../global/util/mutations';
import { AppError } from '../../global/apiPayload/errors';

const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!;
afterEach(() => Object.defineProperty(globalThis, 'crypto', originalCrypto));

test('HTTP 환경에 getRandomValues만 있어도 UUIDv4·UUIDv7을 생성한다', () => {
  const getRandomValues = crypto.getRandomValues.bind(crypto);
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { getRandomValues },
  });
  assert.equal(crypto.randomUUID, undefined);
  for (const [create, version] of [
    [uuidV4, '4'],
    [uuidV7, '7'],
  ] as const) {
    const ids = Array.from({ length: 1000 }, create);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.ok(isUUID(id, version));
  }
});

test('UUIDv7에 밀리초 시각·버전·변형·무작위 접미사를 담는다', () => {
  const before = Date.now();
  const ids = Array.from({ length: 1000 }, () => uuidV7());
  const after = Date.now();
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert.ok(isUUID(id, '7'));
    const time = parseInt(id.slice(0, 13).replace('-', ''), 16);
    assert.ok(time >= before && time <= after);
  }
});

test('변경 키가 UUID 버전 1~8을 허용하고 잘못된 키 오류를 유지한다', () => {
  const ticket = uuidV7(),
    payload = { amount: '1000' };
  const digest = mutationDigest(ticket, payload);
  for (const version of ['1', '2', '3', '4', '5', '6', '7', '8']) {
    const id = ticket.slice(0, 14) + version + ticket.slice(15);
    assert.equal(mutationDigest(id, payload), digest);
    assert.equal(mutationDigest(id.toUpperCase(), payload), digest);
  }
  for (const invalid of [
    '',
    'not-a-uuid',
    ` ${ticket}`,
    `${ticket} `,
    '00000000-0000-0000-0000-000000000000',
    'ffffffff-ffff-ffff-ffff-ffffffffffff',
    ticket.slice(0, 14) + '9' + ticket.slice(15),
    ticket.slice(0, 19) + '0' + ticket.slice(20),
  ])
    assert.throws(
      () => mutationDigest(invalid, payload),
      (error: unknown) =>
        error instanceof AppError &&
        error.status === 400 &&
        error.code === 'invalid_request_key',
    );
});
