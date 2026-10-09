import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertServerRejects,
  withExpectedErrorLog,
} from '../support/expectedErrorTestSupport';

test('의도적으로 주입한 오류의 로그와 요청 실패가 같은 객체인지 검증하고 출력기를 복원한다', async (t) => {
  const original = t.mock.method(console, 'error', () => {});
  const injected = new Error('의도한 저장 실패');
  await assertServerRejects(
    t,
    async () => {
      console.error('Unhandled server error', injected);
      throw injected;
    },
    (error) => error === injected,
  );
  assert.equal(original.mock.callCount(), 0);
  assert.equal(console.error, original);
});

test('예상한 오류 로그만 수집하고 다른 서버 오류와 다른 종류의 로그는 그대로 출력한다', async (t) => {
  const original = t.mock.method(console, 'error', () => {});
  const injected = new Error('의도한 저장 실패');
  const unexpected = new Error('예상하지 않은 오류');
  const { result, calls } = await withExpectedErrorLog(
    t,
    (label, error) => label === 'Unhandled server error' && error === injected,
    async () => {
      console.error('Unhandled server error', unexpected);
      console.error('Realtime publication failed', injected);
      console.error('Unhandled server error', injected);
      return 42;
    },
  );
  assert.equal(result, 42);
  assert.equal(calls[0][1], injected);
  assert.deepEqual(
    original.mock.calls.map((call) => call.arguments),
    [
      ['Unhandled server error', unexpected],
      ['Realtime publication failed', injected],
    ],
  );
  assert.equal(console.error, original);
});

test('예상과 다른 오류나 로그 누락은 테스트를 실패시키고 출력기를 복원한다', async (t) => {
  const original = t.mock.method(console, 'error', () => {});
  const injected = new Error('의도한 저장 실패');
  const unexpected = new Error('예상하지 않은 오류');
  await assert.rejects(
    assertServerRejects(
      t,
      async () => {
        console.error('Unhandled server error', unexpected);
        throw unexpected;
      },
      (error) => error === injected,
    ),
    assert.AssertionError,
  );
  assert.equal(original.mock.calls[0].arguments[1], unexpected);
  assert.equal(console.error, original);
  await assert.rejects(
    assertServerRejects(
      t,
      async () => {
        throw injected;
      },
      (error) => error === injected,
    ),
    assert.AssertionError,
  );
  assert.equal(console.error, original);
  await assert.rejects(
    withExpectedErrorLog(
      t,
      () => true,
      async () => {
        console.error('Unhandled server error', injected);
        console.error('Unhandled server error', injected);
      },
    ),
    assert.AssertionError,
  );
  assert.equal(console.error, original);
});
