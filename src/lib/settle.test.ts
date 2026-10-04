import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { GET } from '../app/api/[...path]/route'
import { isSettlePath } from '../Domain/Settle/Backend'

test('Settle dispatch preserves routes, origin, JSON and multipart validation before DB work', async () => {
  for (const path of ['rounds', 'rounds/id', 'receipts/id', 'groups/id/rounds']) assert.equal(isSettlePath(path.split('/')), true)
  for (const path of ['groups', 'groups/id/invites', 'invites/token', 'unknown']) assert.equal(isSettlePath(path.split('/')), false)
  const request = (path: string, method: string, body?: string, origin = 'http://localhost') => GET(
    new NextRequest(`http://localhost/api/${path}`, { method, headers: { origin, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body }) }),
    { params: Promise.resolve({ path: path.split('/') }) },
  )
  assert.equal((await request('rounds/id/confirm', 'POST', '{invalid', 'https://other.example')).status, 403)
  for (const [path, method] of [
    ['groups/id/rounds', 'POST'], ['rounds/id', 'DELETE'], ['rounds/id/expenses', 'POST'],
    ['rounds/id/expenses/e', 'PATCH'], ['rounds/id/expenses/e', 'DELETE'],
    ['rounds/id/members/u/exclude', 'POST'], ['rounds/id/settlement-check', 'POST'],
    ['rounds/id/expenses/e/receipts/r', 'DELETE'],
    ...['confirm', 'reopen', 'send', 'draw', 'complete', 'force-complete'].map(action => [`rounds/id/${action}`, 'POST']),
  ]) assert.equal((await request(path, method, '{invalid')).status, 400, `${method} ${path}`)
  assert.equal((await request('rounds/id/expenses/e/receipts', 'POST', '{invalid')).status, 401)
  for (const [path, method] of [['rounds/id', 'PUT'], ['rounds/id/unknown', 'POST'], ['receipts/id', 'DELETE']]) {
    const response = await request(path, method)
    assert.equal(response.status, 404)
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
  }
})
