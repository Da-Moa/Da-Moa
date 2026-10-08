import type { Pool, PoolClient } from 'pg'
import type { TestContext } from 'node:test'

export function mockPoolConnection(t: TestContext, pool: Pool, work: () => Promise<PoolClient>) {
  return t.mock.method(pool, 'connect', (callback?: (error: Error | null, client?: PoolClient, release?: (error?: Error | boolean) => void) => void) => {
    const pending = work()
    if (!callback) return pending
    void pending.then(client => callback(null, client, client.release.bind(client)), error => callback(error))
  })
}

export function queryText(value: unknown): string {
  return typeof value === 'string' ? value : (value as { text: string }).text
}

// pg pool queries use callbacks, while Prisma transaction queries use promises.
export function queryResult(args: any[], work: (args: any[]) => unknown) {
  const callback = typeof args.at(-1) === 'function' ? args.at(-1) as Function : null
  const pending = Promise.resolve().then(() => work(callback ? args.slice(0, -1) : args))
  if (!callback) return pending
  void pending.then(result => callback(null, result), error => callback(error))
}
