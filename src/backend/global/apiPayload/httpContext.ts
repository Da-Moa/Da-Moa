import { AsyncLocalStorage } from 'node:async_hooks';
import type { Response as ExpressResponse } from 'express';

const callbacks = new AsyncLocalStorage<(() => unknown)[]>();
export function after(work: () => unknown) {
  const pending = callbacks.getStore();
  if (pending) pending.push(work);
  else
    void Promise.resolve()
      .then(work)
      .catch((error) => console.error('Realtime publication failed', error));
}

export function responseScope<T>(response: ExpressResponse, work: () => T): T {
  const pending: (() => unknown)[] = [];
  response.once('finish', () => {
    for (const callback of pending)
      void Promise.resolve()
        .then(callback)
        .catch((error) => console.error('Realtime publication failed', error));
  });
  return callbacks.run(pending, work);
}
