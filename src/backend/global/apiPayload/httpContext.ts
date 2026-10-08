import { AsyncLocalStorage } from 'node:async_hooks';
import { Readable } from 'node:stream';
import { RequestCookies, ResponseCookies } from '@edge-runtime/cookies';
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
} from 'express';

export class HttpRequest extends Request {
  get nextUrl() {
    return new URL(this.url);
  }
  get cookies() {
    return new RequestCookies(this.headers);
  }
}

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

export function copyResponseCookies(
  response: ExpressResponse,
  cookies: HttpResponse,
) {
  const values = cookies.headers.getSetCookie();
  if (values.length) response.setHeader('Set-Cookie', values);
}

const requests = new WeakMap<ExpressRequest, HttpRequest>();
export function webRequest(request: ExpressRequest): HttpRequest {
  const existing = requests.get(request);
  if (existing) return existing;
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value))
      for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  const url = new URL(
    request.originalUrl,
    `${request.protocol}://${request.headers.host || 'localhost'}`,
  );
  const web = new HttpRequest(url, {
    method: request.method,
    headers,
    ...(!['GET', 'HEAD'].includes(request.method)
      ? { body: Readable.toWeb(request), duplex: 'half' }
      : {}),
  } as RequestInit);
  requests.set(request, web);
  return web;
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
