import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dispatch as GET } from '../support/httpTestSupport';
import { createAccessToken } from '../support/legacyTokenTestSupport.ts';

test('모임 Controller가 경로·Origin·입력 오류를 유지하고 수정 API를 추가하지 않는다', async (t) => {
  const previous = process.env.AUTH_JWT_SECRET;
  process.env.AUTH_JWT_SECRET =
    'isolated-group-unit-test-secret-at-least-32-bytes';
  t.after(() => {
    if (previous === undefined) delete process.env.AUTH_JWT_SECRET;
    else process.env.AUTH_JWT_SECRET = previous;
  });
  const token = createAccessToken('unit-user', 'unit-session');
  const request = (
    path: string,
    method: string,
    body?: unknown,
    origin = 'http://localhost',
    authenticated = true,
  ) =>
    GET(
      new Request(`http://localhost/api/${path}`, {
        method,
        headers: {
          origin,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'unit-request-key',
          ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      { params: Promise.resolve({ path: path.split('/') }) },
    );
  assert.equal(
    (
      await request(
        'groups',
        'POST',
        { name: ' ' },
        'https://other.example',
        false,
      )
    ).status,
    401,
  );
  assert.equal(
    (await request('groups', 'POST', { name: '모임' }, 'https://other.example'))
      .status,
    403,
  );
  const invalid = await request('groups', 'POST', { name: ' ' });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), {
    error: 'invalid_input',
    code: 'invalid_input',
    detail: { field: 'name' },
    message: '입력값을 확인해 주세요',
    details: { field: 'name' },
  });
  for (const method of ['PUT', 'PATCH']) {
    const response = await request('groups/id', method, { name: '수정' });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  }
});

test('모임 Repository가 상세 조회에 회원명을 연결하고 회원 수정·트랜잭션·규칙을 담당 계층에 맡긴다', () => {
  const repository = readFileSync(
    'src/backend/domain/group/repository/group.repository.ts',
    'utf8',
  );
  assert.doesNotMatch(repository, /\brefresh_sessions\b/);
  assert.doesNotMatch(
    repository,
    /\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:rounds|round_members)\b/i,
  );
  assert.doesNotMatch(
    repository,
    /\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+users\b/i,
  );
  assert.doesNotMatch(
    repository,
    /\b(?:withWriteTransaction|withReadTransaction|Response|AppError|MAX_GROUP_MEMBERS|FOR UPDATE|pg_advisory_xact_lock)\b/,
  );
  const service = readFileSync(
    'src/backend/domain/group/service/group.service.ts',
    'utf8',
  );
  assert.doesNotMatch(service, /client\.query\(/);
  const controller = readFileSync(
    'src/backend/domain/group/controller/group.controller.ts',
    'utf8',
  );
  assert.doesNotMatch(
    controller,
    /client\.query\(|withWriteTransaction|withReadTransaction/,
  );
});
