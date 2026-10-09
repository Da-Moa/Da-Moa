import { AsyncLocalStorage } from 'node:async_hooks';
import { ResponseCookies } from '@edge-runtime/cookies';
import type { Response as ExpressResponse } from 'express';

export class HttpResponse extends Response {
  readonly cookies = new ResponseCookies(this.headers);
  static json(body: unknown, init?: ResponseInit) {
    const response = Response.json(body, init);
    return new HttpResponse(response.body, response);
  }
  static redirect(url: string | URL, status = 307) {
    return new HttpResponse(null, {
      status,
      headers: { Location: String(url) },
    });
  }
}

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

export async function sendResponse(
  response: ExpressResponse,
  work: () => Promise<Response> | Response,
) {
  const pending: (() => unknown)[] = [];
  await callbacks.run(pending, async () => {
    const result = await work();
    response.status(result.status);
    for (const [name, value] of result.headers)
      if (name !== 'set-cookie') response.setHeader(name, value);
    const cookies = result.headers.getSetCookie();
    if (cookies.length) response.setHeader('Set-Cookie', cookies);
    response.once('finish', () => {
      for (const callback of pending)
        void Promise.resolve()
          .then(callback)
          .catch((error) =>
            console.error('Realtime publication failed', error),
          );
    });
    response.end(Buffer.from(await result.arrayBuffer()));
  });
}
