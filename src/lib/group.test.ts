import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { GET } from '../app/api/[...path]/route'
import { isGroupPath } from '../Domain/Group/Backend'

test('Group controller preserves route dispatch, origin and input errors without adding update APIs', async () => {
  assert.equal(isGroupPath(['groups', 'id', 'rounds']), false)
  assert.equal(isGroupPath(['groups', 'id', 'invites']), true)
  assert.equal(isGroupPath(['invites', 'token', 'accept']), true)
  const request = (path: string, method: string, body?: unknown, origin = 'http://localhost') => GET(
    new NextRequest(`http://localhost/api/${path}`, { method, headers: { origin, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    { params: Promise.resolve({ path: path.split('/') }) },
  )
  assert.equal((await request('groups', 'POST', { name: '모임' }, 'https://other.example')).status, 403)
  const invalid = await request('groups', 'POST', { name: ' ' })
  assert.equal(invalid.status, 400)
  assert.deepEqual(await invalid.json(), { error: 'invalid_input', message: '입력값을 확인해 주세요' })
  for (const method of ['PUT', 'PATCH']) {
    const response = await request('groups/id', method, { name: '수정' })
    assert.equal(response.status, 404)
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
  }
})

test('Group repository joins user names for details and leaves user writes, transactions and rules to their owners', () => {
  const repository = readFileSync('src/Domain/Group/Backend/Repository/GroupRepository.ts', 'utf8')
  assert.doesNotMatch(repository, /\brefresh_sessions\b/)
  assert.doesNotMatch(repository, /\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:rounds|round_members)\b/i)
  assert.doesNotMatch(repository, /\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+users\b/i)
  assert.doesNotMatch(repository, /\b(?:withWriteTransaction|withReadTransaction|Response|AppError|MAX_GROUP_MEMBERS|FOR UPDATE|pg_advisory_xact_lock)\b/)
  const service = readFileSync('src/Domain/Group/Backend/Service/GroupService.ts', 'utf8')
  assert.doesNotMatch(service, /client\.query\(/)
  const controller = readFileSync('src/Domain/Group/Backend/Controller/GroupController.ts', 'utf8')
  assert.doesNotMatch(controller, /client\.query\(|withWriteTransaction|withReadTransaction/)
})
