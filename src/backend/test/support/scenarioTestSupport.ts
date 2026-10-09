import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ResponseCookies } from '@edge-runtime/cookies';
import type { INestApplication } from '@nestjs/common';
import { injectMockRequest, mockOrigin } from './mockHttpTestSupport';
import { uuidV7 } from '../../../shared/uuid';

export class ScenarioUser {
  readonly cookies = new Map<string, string>();
  accessToken?: string;
  id?: string;
  constructor(readonly app: INestApplication) {}
  async send(
    path: string,
    method = 'GET',
    body?: unknown,
    status = 200,
    key: string = randomUUID(),
  ) {
    const origin = mockOrigin(this.app);
    const response = await injectMockRequest(
      this.app,
      `${origin}${path.startsWith('/') ? path : '/api/' + path}`,
      {
        method,
        headers: {
          origin,
          ...(this.accessToken
            ? { authorization: `Bearer ${this.accessToken}` }
            : {}),
          ...(this.cookies.size
            ? {
                cookie: [...this.cookies]
                  .map(([k, v]) => `${k}=${v}`)
                  .join('; '),
              }
            : {}),
          ...(method !== 'GET' ? { 'idempotency-key': key } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
    );
    for (const cookie of new ResponseCookies(response.headers).getAll()) {
      if (
        cookie.maxAge === 0 ||
        (cookie.expires && new Date(cookie.expires).getTime() <= Date.now())
      )
        this.cookies.delete(cookie.name);
      else this.cookies.set(cookie.name, cookie.value);
    }
    if (response.status !== status)
      assert.fail(
        `${method} ${path}: expected ${status}, received ${response.status}: ${await response.clone().text()}`,
      );
    return response;
  }
  async data(
    path: string,
    method = 'GET',
    body?: unknown,
    status = 200,
    key?: string,
  ) {
    const response = await this.send(path, method, body, status, key);
    const payload = await response.json();
    return response.ok ? payload.data : payload;
  }
  async login(code: string, returnTo = '/home') {
    const started = await this.send(
      `auth/kakao?returnTo=${encodeURIComponent(returnTo)}`,
      'GET',
      undefined,
      307,
    );
    const state = new URL(started.headers.get('location')!).searchParams.get(
      'state',
    )!;
    const callback = await this.send(
      `/auth/v1/kakao?code=${code}&state=${state}`,
      'GET',
      undefined,
      307,
    );
    assert.equal(
      new URL(callback.headers.get('location')!).searchParams.get('returnTo'),
      returnTo,
    );
    assert.ok(
      callback.headers
        .getSetCookie()
        .some(
          (cookie) =>
            cookie.startsWith('da_moa_refresh=') && cookie.includes('HttpOnly'),
        ),
    );
    const access = await this.data('auth/access-token', 'POST');
    this.accessToken = access.accessToken;
    const me = await this.data('me');
    this.id = me.id;
    return me;
  }
  async onboard(confirmRejoin = false) {
    const me = await this.data('me');
    const session = await this.data('me/onboarding', 'POST', {
      bankCode: '004',
      accountNumber: '12340312345678',
      accountHolder: '시나리오 사용자',
      expectedBankVersion: me.bankVersion,
      confirmRejoin,
    });
    this.accessToken = session.accessToken;
    this.id = session.id;
    return session;
  }
  async createGroup(name = '시나리오 모임') {
    return this.data('groups', 'POST', { name }, 200, uuidV7());
  }
  async createRound(groupId: string, participants: ScenarioUser[]) {
    return this.data(
      `groups/${groupId}/rounds`,
      'POST',
      {
        name: '시나리오 회차',
        participantIds: participants.map((user) => user.id),
      },
      200,
      uuidV7(),
    );
  }
}
