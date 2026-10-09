import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  createInviteToken,
  isInviteToken,
} from '../../global/util/inviteTokenUtil';

test('생성한 초대 토큰이 URL에 안전한 43자이며 검증을 통과한다', () => {
  for (let index = 0; index < 100; index++) {
    const token = createInviteToken();
    assert.equal(token.length, 43);
    assert.equal(isInviteToken(token), true);
    assert.equal(encodeURIComponent(token), token);
  }
});

test('초대 토큰 검증이 URL 안전 문자와 기존 base64url 토큰을 허용한다', () => {
  for (const character of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-') {
    assert.equal(isInviteToken(character.repeat(43)), true);
  }
  for (let index = 0; index < 100; index++) {
    assert.equal(isInviteToken(randomBytes(32).toString('base64url')), true);
  }
});

test('초대 토큰의 잘못된 타입·길이·공백·지원하지 않는 문자를 거부한다', () => {
  for (const value of [
    undefined,
    null,
    43,
    {},
    [],
    new String('a'.repeat(43)),
    '',
    'a'.repeat(21),
    'a'.repeat(42),
    'a'.repeat(44),
    `${'a'.repeat(43)}\n`,
    ...[
      ' ',
      '\n',
      '\r',
      '\t',
      '\0',
      '/',
      '+',
      '=',
      '.',
      '%',
      '한',
      'é',
      '😀',
    ].map((character) => `${'a'.repeat(42)}${character}`),
  ]) {
    assert.equal(isInviteToken(value), false);
  }
});
