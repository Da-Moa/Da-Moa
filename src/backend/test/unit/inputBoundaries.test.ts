import assert from 'node:assert/strict'
import test from 'node:test'
import { errorResponse } from '../../global/apiPayload/errors.ts'
import { pageOf, decodePageCursor } from '../../global/util/index.ts'

test('pagination cursors include only the position and reject malformed or overflowing values', () => {
  const first = { id: 'entry-one', createdAt: 100, description: 'private expense', accountNumber: '001234' }
  const page = pageOf([first, { ...first, id: 'entry-two' }], 1, row => row)
  assert.deepEqual(JSON.parse(Buffer.from(page.nextCursor!, 'base64url').toString()), { id: 'entry-one', createdAt: '100' })
  assert.deepEqual(decodePageCursor(page.nextCursor!), { id: 'entry-one', createdAt: '100' })
  for (const createdAt of [[1], '999999999999999999999', '10\n']) {
    const cursor = Buffer.from(JSON.stringify({ id: 'entry', createdAt })).toString('base64url')
    assert.throws(() => decodePageCursor(cursor))
  }
})

test('database physical limits are input errors', () => {
  assert.equal(errorResponse({ code: '22003' }).status, 400)
})

test('unknown server errors are logged without exposing their details', async () => {
  const original = console.error
  const calls: unknown[][] = []
  const error = new Error('secret connection details')
  let response: Response
  console.error = (...args: unknown[]) => { calls.push(args) }
  try { response = errorResponse(error) }
  finally { console.error = original }
  assert.deepEqual(calls, [['Unhandled server error', error]])
  assert.equal(response.status, 503)
  assert.equal(JSON.stringify(await response.json()).includes('secret'), false)
})
