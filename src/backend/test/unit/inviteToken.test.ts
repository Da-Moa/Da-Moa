import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  createInviteToken,
  isInviteToken,
} from '../../global/util/inviteTokenUtil';

test('generated invite tokens are 43 URL-safe characters accepted by validation', () => {
  for (let index = 0; index < 100; index++) {
    const token = createInviteToken();
    assert.equal(token.length, 43);
    assert.equal(isInviteToken(token), true);
    assert.equal(encodeURIComponent(token), token);
  }
});

test('invite validation accepts every URL-safe character and legacy base64url tokens', () => {
  for (const character of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-') {
    assert.equal(isInviteToken(character.repeat(43)), true);
  }
  for (let index = 0; index < 100; index++) {
    assert.equal(isInviteToken(randomBytes(32).toString('base64url')), true);
  }
});

test('invite validation rejects wrong types, lengths, whitespace and foreign characters', () => {
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
