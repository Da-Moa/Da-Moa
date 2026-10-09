import {
  expect,
  type APIRequestContext,
  type BrowserContext,
  type Page,
  type TestInfo,
  type WebSocketRoute,
} from '@playwright/test';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { TEST_ACCOUNTS } from '../../../shared/testAccounts';
import { uuidV7 } from '../../../shared/uuid';
import {
  ACCESS_TOKEN_COOKIE_NAME,
  REFRESH_TOKEN_COOKIE_NAME,
} from '../../../backend/global/auth/native';

export const accounts = TEST_ACCOUNTS;

export function tokens(userId: string, expired = false) {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32)
    throw new Error('Browser fixture JWT secret is required');
  const jwt = new JwtService({ secret });
  const sid = randomUUID();
  const sign = (type: string, expiresIn: number) =>
    jwt.sign(
      { sub: userId, sid, token_type: type, purpose: 'app' },
      {
        algorithm: 'HS256',
        audience: 'da-moa',
        issuer: 'da-moa',
        expiresIn,
      },
    );
  return {
    access: sign('access', expired ? -60 : 600),
    refresh: sign('refresh', 3600),
  };
}

export async function signIn(
  context: BrowserContext,
  baseURL: string,
  userId: string,
  expired = false,
) {
  const session = tokens(userId, expired);
  await context.addCookies([
    {
      name: REFRESH_TOKEN_COOKIE_NAME,
      value: session.refresh,
      domain: new URL(baseURL).hostname,
      path: '/api/auth',
      httpOnly: true,
      sameSite: 'Lax',
      secure: false,
    },
  ]);
  await context.addInitScript(
    ({ key, access }) => localStorage.setItem(key, access),
    {
      key: ACCESS_TOKEN_COOKIE_NAME,
      access: session.access,
    },
  );
  return session;
}

export async function api<T>(
  request: APIRequestContext,
  origin: string,
  userId: string,
  path: string,
  method = 'GET',
  data?: unknown,
): Promise<T> {
  const response = await request.fetch(`/api/${path}`, {
    method,
    data,
    headers: {
      Origin: origin,
      Authorization: `Bearer ${tokens(userId).access}`,
      ...(method === 'GET'
        ? {}
        : {
            'Idempotency-Key':
              method === 'POST' &&
              (path === 'groups' || /^groups\/[^/]+\/rounds$/.test(path))
                ? uuidV7()
                : randomUUID(),
          }),
    },
  });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()).data as T;
}

export async function createRound(request: APIRequestContext, origin: string) {
  const a = accounts[0].id,
    b = accounts[1].id;
  const group = await api<{ id: string }>(
    request,
    origin,
    a,
    'groups',
    'POST',
    { name: `브라우저 모임 ${randomUUID()}` },
  );
  const invite = await api<{ sharePath: string }>(
    request,
    origin,
    a,
    `groups/${group.id}/invites`,
    'POST',
    {},
  );
  await api(
    request,
    origin,
    b,
    `invites/${invite.sharePath.split('/').at(-1)}/accept`,
    'POST',
  );
  return api<{ id: string; version: number }>(
    request,
    origin,
    a,
    `groups/${group.id}/rounds`,
    'POST',
    { name: '브라우저 회차', participantIds: [a, b] },
  );
}

export function observeHttp(page: Page, testInfo: TestInfo) {
  const requests: { method: string; path: string }[] = [];
  const responses: { method: string; path: string; status: number }[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/'))
      requests.push({ method: request.method(), path });
  });
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith('/api/'))
      responses.push({
        method: response.request().method(),
        path,
        status: response.status(),
      });
  });
  return {
    requests,
    responses,
    count: (path: string, method = 'GET') =>
      requests.filter((item) => item.path === path && item.method === method)
        .length,
    save: () =>
      testInfo.attach('http-sequence', {
        body: JSON.stringify({ requests, responses }, null, 2),
        contentType: 'application/json',
      }),
  };
}

// The upstream socket and invalidations are real. Withholding delivery proves
// whether a mutation itself causes a GET, before releasing the server event.
export async function observeRealtime(page: Page) {
  const held: { socket: WebSocketRoute; message: string | Buffer }[] = [];
  const keys: string[][] = [];
  let holding = false;
  let connections = 0;
  let current: WebSocketRoute | undefined;
  await page.routeWebSocket('**/realtime', (socket) => {
    current = socket;
    connections++;
    const server = socket.connectToServer();
    socket.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      const event = JSON.parse(message.toString());
      if (event.type === 'invalidate') keys.push(event.keys);
      if (holding) held.push({ socket, message });
      else socket.send(message);
    });
  });
  await page.addInitScript(() => {
    const sockets: WebSocket[] = [];
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        sockets.push(this);
      }
    };
    Object.assign(window, { browserTestSockets: sockets });
  });
  return {
    keys,
    hold: () => {
      holding = true;
    },
    release: () => {
      holding = false;
      for (const { socket, message } of held.splice(0)) socket.send(message);
    },
    disconnect: () => {
      current?.close({ code: 1012, reason: 'browser reconnect regression' });
    },
    connectionCount: () => connections,
    ready: () =>
      page.waitForFunction(() =>
        (
          window as unknown as { browserTestSockets: WebSocket[] }
        ).browserTestSockets.some(
          (socket) => socket.readyState === WebSocket.OPEN,
        ),
      ),
  };
}

export async function expectNoGet(
  page: Page,
  count: () => number,
  baseline: number,
) {
  // Longer than the application's 120ms invalidation debounce, with delivery held.
  await page.waitForTimeout(500);
  expect(count()).toBe(baseline);
}
