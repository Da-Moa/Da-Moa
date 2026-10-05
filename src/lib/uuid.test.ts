import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { uuidV4, uuidV7 } from './uuid'

const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!
afterEach(() => Object.defineProperty(globalThis, 'crypto', originalCrypto))

test('UUIDv4 and UUIDv7 work when HTTP origins expose only getRandomValues', () => {
  const getRandomValues = crypto.getRandomValues.bind(crypto)
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues } })
  assert.equal(crypto.randomUUID, undefined)
  for (const [create, version] of [[uuidV4, '4'], [uuidV7, '7']] as const) {
    const ids = Array.from({ length: 1000 }, create)
    assert.equal(new Set(ids).size, ids.length)
    for (const id of ids) assert.match(id, new RegExp(`^[0-9a-f]{8}-[0-9a-f]{4}-${version}[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`))
  }
})

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
