import assert from 'node:assert/strict'
import test from 'node:test'
import { uuidV7 } from './uuid'

test('UUIDv7 carries a millisecond timestamp, version/variant and random suffix', () => {
  const before = Date.now()
  const ids = Array.from({ length: 1000 }, () => uuidV7())
  const after = Date.now()
  assert.equal(new Set(ids).size, ids.length)
  for (const id of ids) {
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    const time = parseInt(id.slice(0, 13).replace('-', ''), 16)
    assert.ok(time >= before && time <= after)
  }
})
