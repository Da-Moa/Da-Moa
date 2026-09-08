import assert from 'node:assert/strict'
import test from 'node:test'
import { parseInvalidateEvent, realtimeUserChannel, resourceKeysForPath } from './realtime.ts'

test('실시간 메시지는 허용한 재조회 키만 사용한다', () => {
  assert.deepEqual(resourceKeysForPath('/api/rounds/r-1/settlement?x=1'), ['settlement:r-1', 'settlements'])
  assert.deepEqual(resourceKeysForPath('/api/groups/g-1/rounds?status=active'), ['group-rounds:g-1'])
  assert.deepEqual(parseInvalidateEvent({ type: 'invalidate', keys: ['round:r-1', 'round:r-1'] }), { type: 'invalidate', keys: ['round:r-1'] })
  assert.equal(parseInvalidateEvent({ type: 'invalidate', keys: ['account-number:123'] }), null)
  assert.equal(parseInvalidateEvent('{"type":"invalidate","keys":["groups"]}')?.keys[0], 'groups')
  assert.equal(realtimeUserChannel('u-1'), 'da-moa:user:u-1')
})
