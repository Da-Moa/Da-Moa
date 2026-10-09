import './mockStorageTestSupport';
import 'reflect-metadata';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
} from 'express';
import { createRequest, createResponse } from 'node-mocks-http';
import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { RealtimePublisher } from '../../global/util/invalidationUtil';
import { PassThrough, Readable } from 'node:stream';
import { AppModule } from '../../domain/app.module';
import { configureBackend } from '../../domain/main';
import {
  configureOpenApi,
  configureSwaggerUi,
} from '../../global/apiPayload/swagger';

process.env.AUTH_JWT_SECRET ??=
  'mock-request-test-only-secret-at-least-32-bytes';

export type MockNotification = { userId: string; keys: string[] };
export type MockResponse = Response & { notifications: MockNotification[] };
type Effects = {
  notifications: MockNotification[];
  pending: Set<Promise<unknown>>;
};
const effects = new AsyncLocalStorage<Effects>();

function observePublications(publisher: RealtimePublisher) {
  const register = publisher.registerInvalidationPublisher.bind(publisher);
  publisher.registerInvalidationPublisher = (publish) =>
    register((userId, keys) => {
      effects.getStore()?.notifications.push({ userId, keys: [...keys] });
      publish(userId, keys);
    });
  for (const method of [
    'publishInvalidations',
    'publishGroupInvalidation',
    'publishRoundInvalidation',
    'publishBankInvalidation',
    'publishDepartureInvalidation',
  ] as const) {
    const original = publisher[method].bind(publisher);
    Object.assign(publisher, {
      [method]: (...args: unknown[]) => {
        const pending = Reflect.apply(
          original,
          publisher,
          args,
        ) as Promise<unknown>;
        const current = effects.getStore();
        if (current) {
          current.pending.add(pending);
          void pending.then(
            () => current.pending.delete(pending),
            () => current.pending.delete(pending),
          );
        }
        return pending;
      },
    });
  }
}

type AppState = { origin: string; handle: ReturnType<typeof configureBackend> };
const apps = new WeakMap<INestApplication, AppState>();
const origins = new Map<string, INestApplication>();
let nextOrigin = 10000;

export type MockRequestOptions = RequestInit & {
  timeoutMilliseconds?: number;
  /** Raw body chunks. No Content-Length is added; parsers consume the real stream. */
  chunks?: Iterable<Uint8Array | string> | AsyncIterable<Uint8Array | string>;
};

export async function createMockBackend(
  beforeInit?: (app: INestApplication) => Promise<void>,
  override?: (builder: TestingModuleBuilder) => void,
) {
  const builder = Test.createTestingModule({ imports: [AppModule] });
  override?.(builder);
  const module = await builder.compile();
  const app = module.createNestApplication({
    bodyParser: false,
    logger: ['error', 'warn'],
  });
  const handle = configureBackend(app);
  const origin = `http://localhost:${nextOrigin++}`;
  apps.set(app, { origin, handle });
  origins.set(origin, app);
  const close = app.close.bind(app);
  app.close = async () => {
    origins.delete(origin);
    apps.delete(app);
    await close();
  };
  try {
    observePublications(app.get(RealtimePublisher));
    await beforeInit?.(app);
    configureSwaggerUi(app);
    await app.init();
    configureOpenApi(app);
    return { app, handle, origin, request: mockFetch(app) };
  } catch (error) {
    await app.close();
    throw error;
  }
}

export function mockOrigin(app: INestApplication): string {
  const state = apps.get(app);
  if (!state) throw new Error('Mock application is closed or not initialized');
  return state.origin;
}

/** Inject into the registered Express/Nest pipeline; never listen or use fetch. */
export async function injectMockRequest(
  app: INestApplication,
  input: string | URL | Request,
  options: MockRequestOptions = {},
): Promise<MockResponse> {
  const state = apps.get(app);
  if (!state) throw new Error('Mock application is closed or not initialized');
  const source = new Request(
    input instanceof Request ? input : new URL(String(input), state.origin),
    options,
  );
  source.signal.throwIfAborted();
  const url = new URL(source.url);
  const headers = Object.fromEntries(source.headers);
  // Raw mock headers preserve whitespace for required-header and key boundaries.
  if (options.headers && !(options.headers instanceof Headers)) {
    const entries = Array.isArray(options.headers)
      ? options.headers
      : Object.entries(options.headers);
    for (const [name, value] of entries)
      headers[name.toLowerCase()] = String(value);
  }
  headers.host ??= url.host;
  let chunks = options.chunks;
  if (!chunks) {
    const bytes = Buffer.from(await source.arrayBuffer());
    chunks = bytes.length ? [bytes] : [];
    if (bytes.length && !headers['transfer-encoding'])
      headers['content-length'] ??= String(bytes.length);
  } else {
    headers['transfer-encoding'] ??= 'chunked';
  }
  source.signal.throwIfAborted();
  const metadata = createRequest({
    method: source.method as NonNullable<
      Parameters<typeof createRequest>[0]
    >['method'],
    url: url.pathname + url.search,
    headers,
  });
  const request = Object.assign(Readable.from(chunks), {
    method: metadata.method,
    url: metadata.url,
    originalUrl: metadata.originalUrl,
    headers: metadata.headers,
    httpVersion: '1.1',
    httpVersionMajor: 1,
    httpVersionMinor: 1,
    complete: true,
    socket: Object.assign(new PassThrough(), {
      remoteAddress: '127.0.0.1',
      encrypted: url.protocol === 'https:',
    }),
  }) as unknown as ExpressRequest;
  const response = createResponse<ExpressResponse>({
    req: request,
    eventEmitter: EventEmitter,
  });
  // Keep native Express serialization/cookie semantics; mocks only store writes.
  for (const name of [
    'status',
    'json',
    'send',
    'cookie',
    'clearCookie',
    'append',
    'set',
    'get',
    'redirect',
    'location',
    'type',
  ]) {
    (response as any)[name] = state.handle.response[name];
  }
  const current: Effects = { notifications: [], pending: new Set() };
  return effects.run(current, async () => {
    try {
      const resultResponse = await new Promise<Response>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          source.signal.removeEventListener('abort', abort);
          response.removeListener('finish', finish);
          response.removeListener('error', fail);
        };
        const fail = (error: unknown) => {
          cleanup();
          reject(error);
        };
        const abort = () => fail(source.signal.reason);
        const finish = () => {
          cleanup();
          try {
            const outputHeaders = new Headers();
            for (const [name, value] of Object.entries(
              response._getHeaders(),
            )) {
              if (Array.isArray(value))
                value.forEach((item) =>
                  outputHeaders.append(name, String(item)),
                );
              else if (value !== undefined)
                outputHeaders.set(name, String(value));
            }
            const stored = response._getBuffer();
            const body = stored.length
              ? stored
              : Buffer.from(String(response._getData() ?? ''));
            resolve(
              new Response(
                source.method === 'HEAD' ||
                  [204, 304].includes(response.statusCode)
                  ? null
                  : new Uint8Array(body),
                { status: response.statusCode, headers: outputHeaders },
              ),
            );
          } catch (error) {
            reject(error);
          }
        };
        const timer = setTimeout(
          () =>
            fail(
              new Error(
                `Mock request timed out: ${source.method} ${url.pathname}`,
              ),
            ),
          options.timeoutMilliseconds ?? 30000,
        );
        source.signal.addEventListener('abort', abort, { once: true });
        response.once('finish', finish);
        response.once('error', fail);
        // Parsers translate request stream errors through the Nest Filter.
        // Keep an error listener until destruction, without bypassing that response.
        request.on('error', () => {});
        try {
          if (source.signal.aborted) abort();
          else state.handle(request, response);
        } catch (error) {
          fail(error);
        }
      });
      // finish schedules after() callbacks; wait for their real publication work,
      // including recipient DB lookups, before assertions or the next request.
      await Promise.resolve();
      while (current.pending.size)
        await Promise.allSettled([...current.pending]);
      return Object.assign(resultResponse, {
        notifications: current.notifications,
      });
    } finally {
      request.destroy();
      request.socket.destroy();
    }
  });
}

export function mockFetch(app: INestApplication) {
  return (input: string | URL | Request, options?: MockRequestOptions) =>
    injectMockRequest(app, input, options);
}

export function requestMockServer(
  origin: string,
  request: Request,
  timeoutMilliseconds = 30000,
) {
  const app = origins.get(origin);
  if (!app) throw new Error('Unknown mock application origin');
  return injectMockRequest(app, request, { timeoutMilliseconds });
}
