import assert from 'node:assert/strict'
import test from 'node:test'
import { errorResponse } from '../support/nativeResponseTestSupport.ts'
import { pageOf, decodePageCursor } from '../../global/util/index.ts'

test('페이지 커서가 위치 정보만 포함하고 잘못된 값·범위 초과를 거부한다', () => {
  const first = { id: 'entry-one', createdAt: 100, description: 'private expense', accountNumber: '001234' }
  const page = pageOf([first, { ...first, id: 'entry-two' }], 1, row => row)
  assert.deepEqual(JSON.parse(Buffer.from(page.nextCursor!, 'base64url').toString()), { id: 'entry-one', createdAt: '100' })
  assert.deepEqual(decodePageCursor(page.nextCursor!), { id: 'entry-one', createdAt: '100' })
  for (const createdAt of [[1], '999999999999999999999', '10\n']) {
    const cursor = Buffer.from(JSON.stringify({ id: 'entry', createdAt })).toString('base64url')
    assert.throws(() => decodePageCursor(cursor))
  }
})

test('DB 저장 한도 초과를 입력 오류로 처리한다', () => {
  assert.equal(errorResponse({ code: '22003' }).status, 400)
})

test('알 수 없는 서버 오류는 기록하되 상세 정보를 응답에 노출하지 않는다', async () => {
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
