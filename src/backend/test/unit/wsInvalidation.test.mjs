import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';
import { createBackend } from '../../domain/main.ts';
import { GroupService } from '../../domain/group/service/group.service.ts';
import { createAccessToken } from '../../global/auth/native.ts';
import { PrismaService } from '../../global/database/prisma.service.ts';
import { createRateLimitController } from '../../global/rateLimit/native.ts';
import {
  publishGroupInvalidation,
  realtimeEnabled,
} from '../../global/util/invalidationUtil.ts';
import { createWsController } from '../../global/websocket/controller/wsController.mjs';

test(
  'Nest mutations publish directly to authenticated WebSockets without an internal HTTP request',
  { timeout: 10000 },
  async (t) => {
    const previousSecret = process.env.AUTH_JWT_SECRET;
    process.env.AUTH_JWT_SECRET =
      'direct-websocket-test-secret-at-least-32-bytes';
    t.after(() => {
      if (previousSecret === undefined) delete process.env.AUTH_JWT_SECRET;
      else process.env.AUTH_JWT_SECRET = previousSecret;
    });
    // Exercise JWT and account checks while keeping the database isolated.
    t.mock.getter(PrismaService.prototype, 'client', () => ({
      users: {
        findUnique: async ({ where }) => ({
          id: where.id,
          deleted_at: null,
          onboarding_completed_at: '1',
        }),
      },
    }));
    const rateLimit = createRateLimitController();
    const websocket = createWsController(rateLimit);
    const sockets = [];
    let app;
    t.after(async () => {
      sockets.forEach((socket) => socket.terminate());
      websocket.close();
      rateLimit.close();
      await app?.close();
      assert.equal(realtimeEnabled(), false);
    });
    ({ app } = await createBackend(async (backend) => {
      backend.getHttpServer().on('upgrade', websocket.handleUpgrade);
    }));
    t.mock.method(
      app.get(GroupService),
      'createGroup',
      async (_user, _key, _body, captureAudience) => {
        captureAudience?.(['owner']);
        return { id: 'group-1' };
      },
    );
    await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    const messages = new Map();
    for (const userId of ['owner', 'outsider']) {
      messages.set(userId, []);
      const socket = new WebSocket(
        `${origin.replace(/^http/, 'ws')}/realtime`,
        ['da-moa', createAccessToken(userId, 'test-session')],
        { headers: { origin } },
      );
      sockets.push(socket);
      socket.on('message', (bytes) =>
        messages.get(userId).push(JSON.parse(bytes.toString())),
      );
      await once(socket, 'open');
    }
    const realFetch = globalThis.fetch;
    const requests = t.mock.method(globalThis, 'fetch', realFetch);
    const received = once(sockets[0], 'message');
    const response = await fetch(`${origin}/api/groups`, {
      method: 'POST',
      headers: {
        origin,
        authorization: `Bearer ${createAccessToken('owner', 'test-session')}`,
        'content-type': 'application/json',
        'Idempotency-Key': 'direct-invalidation-test',
      },
      body: JSON.stringify({ name: '직접 알림 테스트' }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    await received;
    // Use a delivered marker to observe the outsider's socket without timing sleeps.
    const marker = once(sockets[1], 'message');
    await publishGroupInvalidation('marker', ['outsider'], true);
    await marker;
    assert.deepEqual(messages.get('owner'), [
      { type: 'invalidate', keys: ['groups', 'group:group-1'] },
    ]);
    assert.deepEqual(messages.get('outsider'), [
      { type: 'invalidate', keys: ['group:marker'] },
    ]);
    assert.equal(
      requests.mock.callCount(),
      1,
      'only the original mutation uses HTTP',
    );
    assert.equal(requests.mock.calls[0].arguments[0], `${origin}/api/groups`);
  },
);
