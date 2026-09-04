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
