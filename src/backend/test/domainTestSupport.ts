import { RuntimeModule } from '../global/runtime/runtime.module';
import type { Database } from '../global/database/db';
import { GroupModule } from '../domain/group/module/group.module';
import { SettleModule } from '../domain/settle/module/settle.module';
import { PrismaService } from '../global/database/prisma.service';
import { databaseRows } from '../global/database/rowMapping';
import {
  inspectionDatabase,
  type InspectionDatabase,
} from './inspectionDatabase';
import 'reflect-metadata';
import { after } from 'node:test';
import { NestFactory } from '@nestjs/core';
import { Module, type Type } from '@nestjs/common';
import { UserModule } from '../domain/user/module/user.module';
import { AuthModule } from '../global/auth/module/auth.module';
import { HealthModule } from '../domain/health/module/health.module';
import { UserService } from '../domain/user/service/user.service';
import { GroupService } from '../domain/group/service/group.service';
import { SettleService } from '../domain/settle/service/settle.service';
import { AuthService } from '../global/auth/service/auth.service';
import { AuthorizationService } from '../global/auth/service/authorization.service';
import { UserRepository } from '../domain/user/repository/user.repository';
import { createValidationPipe } from '../global/apiPayload/validation.pipe';
import { PageQueryDTO } from '../global/apiPayload/dto/req/page.request.dto';
import {
  CreateGroupRequestDTO,
  CreateInviteRequestDTO,
  GroupListQueryDTO,
} from '../domain/group/dto/req/group.request.dto';
import { objectBody } from '../global/util/mutations';
import {
  RoundListQueryDTO,
  parseRoundListQuery,
} from '../domain/settle/dto/req/settle.request.dto';
import {
  parsePageQuery,
  parseSearchPageQuery,
} from '../global/apiPayload/pageQuery';

// Existing domain fixtures describe raw query strings. Run the same Nest DTO
// boundary here; production Services accept only the resulting typed query.
async function testQuery<T extends PageQueryDTO>(
  dto: Type<T>,
  query: URLSearchParams,
): Promise<T> {
  const values: Record<string, string | string[]> = Object.create(null);
  for (const [name, value] of query) {
    const previous = values[name];
    values[name] =
      previous === undefined
        ? value
        : [...(Array.isArray(previous) ? previous : [previous]), value];
  }
  return createValidationPipe().transform(values, {
    type: 'query',
    metatype: dto,
  });
}

async function testBody<T>(dto: Type<T>, input: unknown): Promise<T> {
  return createValidationPipe().transform(objectBody(input), {
    type: 'body',
    metatype: dto,
  });
}

@Module({
  imports: [
    RuntimeModule,
    UserModule,
    GroupModule,
    SettleModule,
    AuthModule,
    HealthModule,
  ],
})
class DomainTestModule {}
let context:
  ReturnType<typeof NestFactory.createApplicationContext> | undefined;
export async function testProvider<T>(token: Type<T>): Promise<T> {
  context ??= NestFactory.createApplicationContext(DomainTestModule, {
    logger: ['error'],
  });
  return (await context).get(token);
}
after(async () => {
  if (context) await (await context).close();
});

export async function completeOnboarding(
  ...args: Parameters<UserService['completeOnboarding']>
): Promise<Awaited<ReturnType<UserService['completeOnboarding']>>> {
  return (await testProvider(UserService)).completeOnboarding(...args);
}

export async function updateBankAccount(
  ...args: Parameters<UserService['updateBankAccount']>
): Promise<Awaited<ReturnType<UserService['updateBankAccount']>>> {
  return (await testProvider(UserService)).updateBankAccount(...args);
}

export async function withdrawAccount(
  ...args: Parameters<UserService['withdrawAccount']>
): Promise<Awaited<ReturnType<UserService['withdrawAccount']>>> {
  return (await testProvider(UserService)).withdrawAccount(...args);
}

export async function getMe(
  ...args: Parameters<UserService['getMe']>
): Promise<Awaited<ReturnType<UserService['getMe']>>> {
  return (await testProvider(UserService)).getMe(...args);
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
  const parsed = await testQuery(GroupListQueryDTO, query);
  return (await testProvider(GroupService)).listGroups(
    access,
    parseSearchPageQuery(parsed),
  );
}

export async function getGroup(
  ...args: Parameters<GroupService['getGroup']>
): Promise<Awaited<ReturnType<GroupService['getGroup']>>> {
  return (await testProvider(GroupService)).getGroup(...args);
}

export async function createGroup(
  access: Parameters<GroupService['createGroup']>[0],
  key: string,
  body: unknown,
  captureAudience?: Parameters<GroupService['createGroup']>[3],
): Promise<Awaited<ReturnType<GroupService['createGroup']>>> {
  const parsed = await testBody(CreateGroupRequestDTO, body);
  return (await testProvider(GroupService)).createGroup(
    access,
    key,
    parsed,
    captureAudience,
  );
}

export async function leaveGroup(
  ...args: Parameters<GroupService['leaveGroup']>
): Promise<Awaited<ReturnType<GroupService['leaveGroup']>>> {
  return (await testProvider(GroupService)).leaveGroup(...args);
}

export async function createInvite(
  access: Parameters<GroupService['createInvite']>[0],
  key: string,
  groupId: string,
  body: unknown,
  captureAudience?: Parameters<GroupService['createInvite']>[4],
): Promise<Awaited<ReturnType<GroupService['createInvite']>>> {
  const parsed = await testBody(CreateInviteRequestDTO, body);
  return (await testProvider(GroupService)).createInvite(
    access,
    key,
    groupId,
    parsed,
    captureAudience,
  );
}

export async function revokeInvite(
  ...args: Parameters<GroupService['revokeInvite']>
): Promise<Awaited<ReturnType<GroupService['revokeInvite']>>> {
  return (await testProvider(GroupService)).revokeInvite(...args);
}

export async function getInvite(
  ...args: Parameters<GroupService['getInvite']>
): Promise<Awaited<ReturnType<GroupService['getInvite']>>> {
  return (await testProvider(GroupService)).getInvite(...args);
}

export async function acceptInvite(
  ...args: Parameters<GroupService['acceptInvite']>
): Promise<Awaited<ReturnType<GroupService['acceptInvite']>>> {
  return (await testProvider(GroupService)).acceptInvite(...args);
}

export async function listRounds(
  access: Parameters<SettleService['listRounds']>[0],
  query: URLSearchParams,
  groupId?: string,
): Promise<Awaited<ReturnType<SettleService['listRounds']>>> {
  const parsed = await testQuery(RoundListQueryDTO, query);
  return (await testProvider(SettleService)).listRounds(
    access,
    parseRoundListQuery(parsed),
    groupId,
  );
}

export async function getRound(
  access: Parameters<SettleService['getRound']>[0],
  roundId: string,
  query: URLSearchParams,
): Promise<Awaited<ReturnType<SettleService['getRound']>>> {
  const parsed = await testQuery(PageQueryDTO, query);
  return (await testProvider(SettleService)).getRound(
    access,
    roundId,
    parsePageQuery(parsed),
  );
}

export async function createRound(
  ...args: Parameters<SettleService['createRound']>
): Promise<Awaited<ReturnType<SettleService['createRound']>>> {
  return (await testProvider(SettleService)).createRound(...args);
}

export async function saveExpense(
  ...args: Parameters<SettleService['saveExpense']>
): Promise<Awaited<ReturnType<SettleService['saveExpense']>>> {
  return (await testProvider(SettleService)).saveExpense(...args);
}

export async function deleteExpense(
  ...args: Parameters<SettleService['deleteExpense']>
): Promise<Awaited<ReturnType<SettleService['deleteExpense']>>> {
  return (await testProvider(SettleService)).deleteExpense(...args);
}

export async function checkExclusion(
  ...args: Parameters<SettleService['checkExclusion']>
): Promise<Awaited<ReturnType<SettleService['checkExclusion']>>> {
  return (await testProvider(SettleService)).checkExclusion(...args);
}

export async function excludeMember(
  ...args: Parameters<SettleService['excludeMember']>
): Promise<Awaited<ReturnType<SettleService['excludeMember']>>> {
  return (await testProvider(SettleService)).excludeMember(...args);
}

export async function roundCommand(
  ...args: Parameters<SettleService['roundCommand']>
): Promise<Awaited<ReturnType<SettleService['roundCommand']>>> {
  return (await testProvider(SettleService)).roundCommand(...args);
}

export async function setSettlementCheck(
  ...args: Parameters<SettleService['setSettlementCheck']>
): Promise<Awaited<ReturnType<SettleService['setSettlementCheck']>>> {
  return (await testProvider(SettleService)).setSettlementCheck(...args);
}

export async function getSettlement(
  ...args: Parameters<SettleService['getSettlement']>
): Promise<Awaited<ReturnType<SettleService['getSettlement']>>> {
  return (await testProvider(SettleService)).getSettlement(...args);
}

export async function addReceipt(
  ...args: Parameters<SettleService['addReceipt']>
): Promise<Awaited<ReturnType<SettleService['addReceipt']>>> {
  const [access, key, roundId, expenseId, ...input] = args;
  return (await testProvider(SettleService)).addReceipt(
    access,
    key,
    roundId,
    expenseId,
    ...input,
  );
}

export async function removeReceipt(
  ...args: Parameters<SettleService['removeReceipt']>
): Promise<Awaited<ReturnType<SettleService['removeReceipt']>>> {
  return (await testProvider(SettleService)).removeReceipt(...args);
}

export async function getReceipt(
  ...args: Parameters<SettleService['getReceipt']>
): Promise<Awaited<ReturnType<SettleService['getReceipt']>>> {
  return (await testProvider(SettleService)).getReceipt(...args);
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
  client: import('../global/database/db').Database,
  userId: string,
) {
  const row = await client.prisma.users.findFirst({ where: { id: userId } });
  return row
    ? databaseRows<import('../domain/user/dao/user.dao').UserRow>(row)
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
