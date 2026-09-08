import assert from 'node:assert/strict'
import test from 'node:test'
import { rotateRefreshSession } from './auth-store.ts'

test('refresh rotation requires a distinct replacement before querying the database', async () => {
  await assert.rejects(
    rotateRefreshSession({
      expiresAt: 2,
      id: 'replacement-session',
      issuedAt: 1,
      now: 1,
      previousSessionId: 'previous-session',
      previousTokenHash: 'same-token-hash',
      tokenHash: 'same-token-hash',
      userId: 'user-id',
    }),
    /requires a new token/,
  )
})

import { parseBankAccount } from './auth-store.ts'

test('bank input keeps leading zeros, normalizes separators, and rejects invalid account data', () => {
  assert.deepEqual(parseBankAccount({ bankName: ' 우리 ', accountHolder: ' 홍길동 ', accountNumber: '00-123 45' }), {
    bankName: '우리', accountHolder: '홍길동', accountNumber: '0012345',
  })
  for (const accountNumber of ['', ' - ', '123e5', 12345, '123\n45', '001\n', '001\r', 'a123', '1'.repeat(65)]) {
    assert.throws(() => parseBankAccount({ bankName: '은행', accountHolder: '이름', accountNumber }), /계좌번호/)
  }
  assert.throws(() => parseBankAccount({ bankName: ' ', accountHolder: '이름', accountNumber: '012' }), /은행명/)
})
