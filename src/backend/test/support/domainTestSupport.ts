import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../global/apiPayload/errors';
import { createAccessToken } from './legacyTokenTestSupport';
import { getSessionSecret } from '../../global/auth/authConfig';
import { injectMockRequest, mockOrigin } from './mockHttpTestSupport';
import type { Database } from '../../global/database/db';
import { PrismaService } from '../../global/database/prisma.service';
import { databaseRows } from '../../global/database/rowMapping';
import {
  inspectionDatabase,
  type InspectionDatabase,
} from './inspectionDatabase';
import 'reflect-metadata';
import { after } from 'node:test';
import { createMockBackend } from './mockHttpTestSupport';
import type { Type } from '@nestjs/common';
import { UserService } from '../../domain/user/service/user.service';
import { GroupService } from '../../domain/group/service/group.service';
import {
  SettleService,
  type ReceiptUpload,
} from '../../domain/settle/service/settle.service';
import { AuthService } from '../../global/auth/service/auth.service';
import { AuthorizationService } from '../../global/auth/service/authorization.service';
import { UserRepository } from '../../domain/user/repository/user.repository';
type Observation = {
  method: string;
  capture?: (...values: any[]) => void;
  result?: any;
  error?: unknown;
};
const requests = new AsyncLocalStorage<Observation>();
async function apiCall(
  method: string,
  access: Parameters<UserService['getMe']>[0],
  path: string,
  verb = 'GET',
  body?: unknown,
  key?: string,
  capture?: (...values: any[]) => void,
  chunks?: AsyncIterable<Uint8Array | string>,
  contentType?: string,
) {
  const app = await testApplication(),
    origin = mockOrigin(app);
  const observation: Observation = { method, capture };
  const token = access
    ? createAccessToken(
        access.userId,
        access.sessionId,
        getSessionSecret(),
        Math.floor(Date.now() / 1000),
        600,
        access.purpose,
      )
    : null;
  return requests.run(observation, async () => {
    const response = await injectMockRequest(app, `${origin}/api/${path}`, {
      method: verb,
      headers: {
        origin,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(key ? { 'idempotency-key': key } : {}),
        ...(contentType || body !== undefined
          ? { 'content-type': contentType ?? 'application/json' }
          : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      chunks,
    });
    if (!response.ok) {
      const payload = await response.json();
      // SQL rollback tests retain the original service failure after the real Filter ran.
      throw (
        observation.error ??
        new AppError(
          response.status,
          payload.code ?? payload.error,
          payload.message ?? '로그인이 필요합니다',
          payload.details ?? payload.detail,
        )
      );
    }
    if (method === 'getReceipt') {
      assert.deepEqual(
        Buffer.from(await response.arrayBuffer()),
        Buffer.from(observation.result.content),
      );
    } else {
      const payload = await response.json();
      if (method === 'completeOnboarding') {
        assert.equal(payload.data.id, observation.result.userId);
        assert.equal(payload.data.accessToken, observation.result.accessToken);
        assert.ok(
          response.headers
            .getSetCookie()
            .some((cookie) => cookie.startsWith('da_moa_refresh=')),
        );
      } else if (method !== 'withdrawAccount')
        assert.deepEqual(
          payload.data,
          JSON.parse(JSON.stringify(observation.result)),
        );
    }
    return observation.result;
  });
}

let context: ReturnType<typeof createMockBackend> | undefined;
export async function testApplication() {
  context ??= createMockBackend(async (app) => {
    // Observe real service calls per request, including concurrent SQL regressions.
    for (const type of [UserService, GroupService, SettleService]) {
      const service = app.get(type as Type<any>);
      for (const method of Object.getOwnPropertyNames(
        Object.getPrototypeOf(service),
      )) {
        if (
          ![
            'completeOnboarding',
            'updateBankAccount',
            'withdrawAccount',
            'getMe',
            'listGroups',
            'getGroup',
            'createGroup',
            'leaveGroup',
            'createInvite',
            'revokeInvite',
            'getInvite',
            'acceptInvite',
            'listRounds',
            'getRound',
            'createRound',
            'createExpense',
            'updateExpense',
            'deleteExpense',
            'checkExclusion',
            'excludeMember',
            'roundCommand',
            'setSettlementCheck',
            'getSettlement',
            'admitReceipt',
            'saveReceipt',
            'removeReceipt',
            'getReceipt',
          ].includes(method)
        )
          continue;
        const original = service[method].bind(service);
        service[method] = async (...args: any[]) => {
          const observation = requests.getStore();
          if (
            observation?.method === method &&
            observation.capture &&
            typeof args.at(-1) === 'function'
          ) {
            const capture = args.at(-1);
            args[args.length - 1] = (...values: any[]) => {
              capture(...values);
              observation.capture!(...values);
            };
          }
          try {
            const result = await original(...args);
            if (observation?.method === method) observation.result = result;
            return result;
          } catch (error) {
            if (observation) observation.error = error;
            throw error;
          }
        };
      }
    }
  });
  return (await context).app;
}
export async function testProvider<T>(token: Type<T>): Promise<T> {
  return (await testApplication()).get(token);
}
after(async () => {
  if (context) await (await context).app.close();
});

export async function completeOnboarding(
  access: Parameters<UserService['completeOnboarding']>[0],
  input: unknown,
): Promise<Awaited<ReturnType<UserService['completeOnboarding']>>> {
  return apiCall('completeOnboarding', access, 'me/onboarding', 'POST', input);
}

export async function updateBankAccount(
  access: Parameters<UserService['updateBankAccount']>[0],
  key: string,
  input: unknown,
): Promise<Awaited<ReturnType<UserService['updateBankAccount']>>> {
  return apiCall(
    'updateBankAccount',
    access,
    'me/bank-account',
    'PUT',
    input,
    key,
  );
}

export async function withdrawAccount(
  ...args: Parameters<UserService['withdrawAccount']>
): Promise<Awaited<ReturnType<UserService['withdrawAccount']>>> {
  return apiCall('withdrawAccount', args[0], 'auth/withdraw', 'POST');
}

export async function getMe(
  ...args: Parameters<UserService['getMe']>
): Promise<Awaited<ReturnType<UserService['getMe']>>> {
  return apiCall('getMe', args[0], 'me');
}

export async function findOrCreateKakaoUser(
  ...args: Parameters<UserService['findOrCreateKakaoUser']>
): Promise<Awaited<ReturnType<UserService['findOrCreateKakaoUser']>>> {
  return (await testProvider(UserService)).findOrCreateKakaoUser(...args);
}

export async function createTestOnboardingUser(
  ...args: Parameters<UserService['createTestOnboardingUser']>
): Promise<Awaited<ReturnType<UserService['createTestOnboardingUser']>>> {
  return (await testProvider(UserService)).createTestOnboardingUser(...args);
}

export async function getTestSignInUser(
  ...args: Parameters<UserService['getTestSignInUser']>
): Promise<Awaited<ReturnType<UserService['getTestSignInUser']>>> {
  return (await testProvider(UserService)).getTestSignInUser(...args);
}

export async function requireGroupMembership(
  ...args: Parameters<GroupService['requireGroupMembership']>
): Promise<Awaited<ReturnType<GroupService['requireGroupMembership']>>> {
  return (await testProvider(GroupService)).requireGroupMembership(...args);
}

export async function listGroups(
  access: Parameters<GroupService['listGroups']>[0],
  query: URLSearchParams,
): Promise<Awaited<ReturnType<GroupService['listGroups']>>> {
  return apiCall('listGroups', access, `groups?${query}`);
}

export async function getGroup(
  ...args: Parameters<GroupService['getGroup']>
): Promise<Awaited<ReturnType<GroupService['getGroup']>>> {
  return apiCall('getGroup', args[0], `groups/${encodeURIComponent(args[1])}`);
}

export async function createGroup(
  access: Parameters<GroupService['createGroup']>[0],
  key: string,
  body: unknown,
  captureAudience?: Parameters<GroupService['createGroup']>[3],
): Promise<Awaited<ReturnType<GroupService['createGroup']>>> {
  return apiCall(
    'createGroup',
    access,
    'groups',
    'POST',
    body,
    key,
    captureAudience,
  );
}

export async function leaveGroup(
  ...args: Parameters<GroupService['leaveGroup']>
): Promise<Awaited<ReturnType<GroupService['leaveGroup']>>> {
  return apiCall(
    'leaveGroup',
    args[0],
    `groups/${encodeURIComponent(args[2])}`,
    'DELETE',
    undefined,
    args[1],
    args[3],
  );
}

export async function createInvite(
  access: Parameters<GroupService['createInvite']>[0],
  key: string,
  groupId: string,
  body: unknown,
  captureAudience?: Parameters<GroupService['createInvite']>[4],
): Promise<Awaited<ReturnType<GroupService['createInvite']>>> {
  return apiCall(
    'createInvite',
    access,
    `groups/${encodeURIComponent(groupId)}/invites`,
    'POST',
    body,
    key,
    captureAudience,
  );
}

export async function revokeInvite(
  ...args: Parameters<GroupService['revokeInvite']>
): Promise<Awaited<ReturnType<GroupService['revokeInvite']>>> {
  return apiCall(
    'revokeInvite',
    args[0],
    `groups/${encodeURIComponent(args[2])}/invites/${encodeURIComponent(args[3])}`,
    'DELETE',
    undefined,
    args[1],
    args[4],
  );
}

export async function getInvite(
  ...args: Parameters<GroupService['getInvite']>
): Promise<Awaited<ReturnType<GroupService['getInvite']>>> {
  return apiCall(
    'getInvite',
    args[0],
    `invites/${encodeURIComponent(args[1])}`,
  );
}

export async function acceptInvite(
  ...args: Parameters<GroupService['acceptInvite']>
): Promise<Awaited<ReturnType<GroupService['acceptInvite']>>> {
  return apiCall(
    'acceptInvite',
    args[0],
    `invites/${encodeURIComponent(args[2])}/accept`,
    'POST',
    undefined,
    args[1],
    args[3],
  );
}

export async function listRounds(
  access: Parameters<SettleService['listRounds']>[0],
  query: URLSearchParams,
  groupId?: string,
): Promise<Awaited<ReturnType<SettleService['listRounds']>>> {
  return apiCall(
    'listRounds',
    access,
    `${groupId ? `groups/${encodeURIComponent(groupId)}/rounds` : 'rounds'}?${query}`,
  );
}

export async function getRound(
  access: Parameters<SettleService['getRound']>[0],
  roundId: string,
  query: URLSearchParams,
): Promise<Awaited<ReturnType<SettleService['getRound']>>> {
  return apiCall(
    'getRound',
    access,
    `rounds/${encodeURIComponent(roundId)}?${query}`,
  );
}

export async function createRound(
  access: Parameters<SettleService['createRound']>[0],
  key: string,
  groupId: string,
  body: unknown,
  captureAudience?: Parameters<SettleService['createRound']>[4],
): Promise<Awaited<ReturnType<SettleService['createRound']>>> {
  return apiCall(
    'createRound',
    access,
    `groups/${encodeURIComponent(groupId)}/rounds`,
    'POST',
    body,
    key,
    captureAudience,
  );
}

export async function saveExpense(
  access: Parameters<SettleService['createExpense']>[0],
  key: string,
  roundId: string,
  body: unknown,
  expenseId?: string,
  captureAudience?: Parameters<SettleService['createExpense']>[4],
): Promise<Awaited<ReturnType<SettleService['createExpense']>>> {
  return apiCall(
    expenseId ? 'updateExpense' : 'createExpense',
    access,
    `rounds/${encodeURIComponent(roundId)}/expenses${expenseId ? '/' + encodeURIComponent(expenseId) : ''}`,
    expenseId ? 'PATCH' : 'POST',
    body,
    key,
    captureAudience,
  );
}

export async function deleteExpense(
  access: Parameters<SettleService['deleteExpense']>[0],
  key: string,
  roundId: string,
  expenseId: string,
  body: unknown,
  captureAudience?: Parameters<SettleService['deleteExpense']>[5],
): Promise<Awaited<ReturnType<SettleService['deleteExpense']>>> {
  return apiCall(
    'deleteExpense',
    access,
    `rounds/${encodeURIComponent(roundId)}/expenses/${encodeURIComponent(expenseId)}`,
    'DELETE',
    body,
    key,
    captureAudience,
  );
}

export async function checkExclusion(
  ...args: Parameters<SettleService['checkExclusion']>
): Promise<Awaited<ReturnType<SettleService['checkExclusion']>>> {
  return apiCall(
    'checkExclusion',
    args[0],
    `rounds/${encodeURIComponent(args[1])}/members/${encodeURIComponent(args[2])}/exclusion-check`,
  );
}

export async function excludeMember(
  access: Parameters<SettleService['excludeMember']>[0],
  key: string,
  roundId: string,
  targetId: string,
  body: unknown,
  captureAudience?: Parameters<SettleService['excludeMember']>[5],
): Promise<Awaited<ReturnType<SettleService['excludeMember']>>> {
  return apiCall(
    'excludeMember',
    access,
    `rounds/${encodeURIComponent(roundId)}/members/${encodeURIComponent(targetId)}/exclude`,
    'POST',
    body,
    key,
    captureAudience,
  );
}

export async function roundCommand(
  access: Parameters<SettleService['roundCommand']>[0],
  key: string,
  roundId: string,
  action: string,
  body: unknown,
  captureAudience?: Parameters<SettleService['roundCommand']>[5],
): Promise<Awaited<ReturnType<SettleService['roundCommand']>>> {
  return apiCall(
    'roundCommand',
    access,
    `rounds/${encodeURIComponent(roundId)}${action === 'cancel' ? '' : '/' + action}`,
    action === 'cancel' ? 'DELETE' : 'POST',
    body,
    key,
    captureAudience,
  );
}

export async function setSettlementCheck(
  access: Parameters<SettleService['setSettlementCheck']>[0],
  key: string,
  roundId: string,
  body: unknown,
  captureAudience?: Parameters<SettleService['setSettlementCheck']>[4],
): Promise<Awaited<ReturnType<SettleService['setSettlementCheck']>>> {
  return apiCall(
    'setSettlementCheck',
    access,
    `rounds/${encodeURIComponent(roundId)}/settlement-check`,
    'POST',
    body,
    key,
    captureAudience,
  );
}

export async function getSettlement(
  ...args: Parameters<SettleService['getSettlement']>
): Promise<Awaited<ReturnType<SettleService['getSettlement']>>> {
  return apiCall(
    'getSettlement',
    args[0],
    `rounds/${encodeURIComponent(args[1])}/settlement`,
  );
}

// Fixture overloads encode a lazy multipart stream for the registered Controller.
// Production Services still receive only the parsed upload.
export async function addReceipt(
  access: Parameters<SettleService['admitReceipt']>[0],
  key: string,
  roundId: string,
  expenseId: string,
  ...input:
    | [
        expectedVersion: number,
        bytes: Uint8Array,
        type: string,
        captureAudience?: Parameters<SettleService['saveReceipt']>[2],
      ]
    | [
        readUpload: () => Promise<ReceiptUpload>,
        captureAudience?: Parameters<SettleService['saveReceipt']>[2],
      ]
): Promise<Awaited<ReturnType<SettleService['saveReceipt']>>> {
  const boundary = `mock-${randomUUID()}`;
  const capture = typeof input[0] === 'function' ? input[1] : input[3];
  const chunks = {
    async *[Symbol.asyncIterator]() {
      const upload: ReceiptUpload =
        typeof input[0] === 'function'
          ? await input[0]()
          : {
              expectedVersion: input[0],
              bytes: input[1] as Uint8Array,
              type: input[2] as string,
            };
      const name = upload.name ?? `receipt.${upload.type.split('/')[1]}`;
      yield `--${boundary}\r\nContent-Disposition: form-data; name="expectedVersion"\r\n\r\n${upload.expectedVersion}\r\n`;
      yield `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${upload.type}\r\n\r\n`;
      yield Buffer.from(upload.bytes);
      yield `\r\n--${boundary}--\r\n`;
    },
  };
  return apiCall(
    'saveReceipt',
    access,
    `rounds/${encodeURIComponent(roundId)}/expenses/${encodeURIComponent(expenseId)}/receipts`,
    'POST',
    undefined,
    key,
    capture as ((...values: any[]) => void) | undefined,
    chunks,
    `multipart/form-data; boundary=${boundary}`,
  );
}

export async function removeReceipt(
  access: Parameters<SettleService['removeReceipt']>[0],
  key: string,
  roundId: string,
  expenseId: string,
  receiptId: string,
  body: unknown,
  captureAudience?: Parameters<SettleService['removeReceipt']>[6],
): Promise<Awaited<ReturnType<SettleService['removeReceipt']>>> {
  return apiCall(
    'removeReceipt',
    access,
    `rounds/${encodeURIComponent(roundId)}/expenses/${encodeURIComponent(expenseId)}/receipts/${encodeURIComponent(receiptId)}`,
    'DELETE',
    body,
    key,
    captureAudience,
  );
}

export async function getReceipt(
  ...args: Parameters<SettleService['getReceipt']>
): Promise<Awaited<ReturnType<SettleService['getReceipt']>>> {
  return apiCall(
    'getReceipt',
    args[0],
    `receipts/${encodeURIComponent(args[1])}`,
  );
}

export async function signInKakao(
  ...args: Parameters<AuthService['signInKakao']>
): Promise<Awaited<ReturnType<AuthService['signInKakao']>>> {
  return (await testProvider(AuthService)).signInKakao(...args);
}

export async function signInTestAccount(
  ...args: Parameters<AuthService['signInTestAccount']>
): Promise<Awaited<ReturnType<AuthService['signInTestAccount']>>> {
  return (await testProvider(AuthService)).signInTestAccount(...args);
}

export async function getAccount(
  ...args: Parameters<AuthorizationService['getAccount']>
): Promise<Awaited<ReturnType<AuthorizationService['getAccount']>>> {
  return (await testProvider(AuthorizationService)).getAccount(...args);
}

export async function requireAccount(
  ...args: Parameters<AuthorizationService['requireAccount']>
): Promise<Awaited<ReturnType<AuthorizationService['requireAccount']>>> {
  return (await testProvider(AuthorizationService)).requireAccount(...args);
}

export async function findUser(
  client: import('../../global/database/db').Database,
  userId: string,
) {
  const row = await client.prisma.users.findFirst({ where: { id: userId } });
  return row
    ? databaseRows<import('../../domain/user/dao/user.dao').UserRow>(row)
    : undefined;
}

export async function saveBankAccount(
  ...args: Parameters<UserRepository['saveBankAccount']>
): Promise<Awaited<ReturnType<UserRepository['saveBankAccount']>>> {
  return (await testProvider(UserRepository)).saveBankAccount(...args);
}

export async function saveOnboarding(
  ...args: Parameters<UserRepository['saveOnboarding']>
): Promise<Awaited<ReturnType<UserRepository['saveOnboarding']>>> {
  return (await testProvider(UserRepository)).saveOnboarding(...args);
}

export async function withDatabaseConnection<T>(
  work: (client: InspectionDatabase) => Promise<T>,
): Promise<T> {
  return (await testProvider(PrismaService)).withDatabaseConnection((client) =>
    work(inspectionDatabase(client)),
  );
}
export async function withReadTransaction<T>(
  work: (client: InspectionDatabase) => Promise<T>,
): Promise<T> {
  return (await testProvider(PrismaService)).withReadTransaction((client) =>
    work(inspectionDatabase(client)),
  );
}
export async function withWriteTransaction<T>(
  work: (client: InspectionDatabase) => Promise<T>,
  beforeLock?: (client: Database) => Promise<void>,
  beforeBegin?: (client: Database) => Promise<void>,
): Promise<T> {
  return (await testProvider(PrismaService)).withWriteTransaction(
    (client) => work(inspectionDatabase(client)),
    beforeLock,
    beforeBegin,
  );
}

export async function getPrismaClient(url: string) {
  return (await testProvider(PrismaService)).clientFor(url);
}
export async function getDatabasePool(url: string) {
  return (await testProvider(PrismaService)).poolFor(url);
}
