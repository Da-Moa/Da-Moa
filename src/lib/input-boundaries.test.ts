import assert from 'node:assert/strict'
import test from 'node:test'
import { AppError, errorResponse } from './errors.ts'
import { pageOf, pagination } from './group-store.ts'
import { readJsonBody } from './http.ts'

test('pagination cursors include only the position and reject malformed or overflowing values', () => {
  const first = { id: 'entry-one', createdAt: 100, description: 'private expense', accountNumber: '001234' }
  const page = pageOf([first, { ...first, id: 'entry-two' }], 1, row => row)
  assert.deepEqual(JSON.parse(Buffer.from(page.nextCursor!, 'base64url').toString()), { id: 'entry-one', createdAt: '100' })
  assert.deepEqual(pagination(new URLSearchParams({ cursor: page.nextCursor! })).cursor, { id: 'entry-one', createdAt: '100' })
  for (const createdAt of [[1], '999999999999999999999', '10\n']) {
    const cursor = Buffer.from(JSON.stringify({ id: 'entry', createdAt })).toString('base64url')
    assert.throws(() => pagination(new URLSearchParams({ cursor })))
  }
})

test('JSON bodies are bounded before parsing and database physical limits are input errors', async () => {
  await assert.rejects(readJsonBody(new Request('http://localhost', { method: 'POST', body: 'x'.repeat(100) }), 50), error => (error as { status: number }).status === 413)
  await assert.rejects(readJsonBody(new Request('http://localhost', { method: 'POST', body: '[]' })), error => error instanceof AppError && error.message === '입력값을 확인해 주세요')
  await assert.rejects(readJsonBody(new Request('http://localhost', { method: 'POST', body: '{' })), error => error instanceof AppError && error.message === '올바른 JSON 입력이 필요합니다')
  assert.deepEqual(await readJsonBody(new Request('http://localhost', { method: 'POST', body: '{"amount":"9007199254740993"}' })), { amount: '9007199254740993' })
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
