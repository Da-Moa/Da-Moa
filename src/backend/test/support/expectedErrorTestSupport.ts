import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

/** Capture only explicitly expected logs; preserve every other diagnostic. */
export async function withExpectedErrorLog<T>(
  t: TestContext,
  expected: (...args: any[]) => boolean,
  work: () => Promise<T>,
  count = 1,
) {
  const original = console.error;
  const calls: unknown[][] = [];
  const logger = t.mock.method(console, 'error', (...args: unknown[]) => {
    let matches = false;
    try {
      matches = expected(...args);
    } catch {
      /* Unexpected errors stay visible. */
    }
    if (matches) calls.push(args);
    else original.apply(console, args);
  });
  try {
    const result = await work();
    assert.equal(calls.length, count, '예상한 오류 로그 횟수가 일치해야 한다');
    return { result, calls };
  } finally {
    logger.mock.restore();
  }
}

export async function assertServerRejects(
  t: TestContext,
  work: () => Promise<unknown>,
  expected: (error: any) => boolean,
) {
  let rejected: unknown;
  const { calls } = await withExpectedErrorLog(
    t,
    (label, error) => label === 'Unhandled server error' && expected(error),
    () =>
      assert.rejects(work, (error) => {
        rejected = error;
        return expected(error);
      }),
  );
  assert.equal(
    calls[0][1],
    rejected,
    '기록된 오류와 요청의 실패가 같아야 한다',
  );
}
