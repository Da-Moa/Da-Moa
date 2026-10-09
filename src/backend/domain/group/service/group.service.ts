import { Injectable, Inject } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { PrismaService } from '../../../global/database/prisma.service';
import { groupErrors } from '../code/group.error.code';
import { GroupException } from '../exception/group.exception';
import { createHash, randomUUID } from 'node:crypto';
import { AuthorizationService } from '../../../global/auth/service/authorization.service';
import {
  createInviteToken,
  isInviteToken,
  nowSeconds,
  pageOf,
  type SearchPageQuery,
  type Database,
  type Identity,
} from '../../../global/util';
import { mutationDigest, mutationResult } from '../../../global/util/mutations';
import { getActiveUserProfiles } from '../../user/repository';
import {
  MAX_GROUP_MEMBERS,
  type GroupDetail,
  type GroupListItem,
  type GroupSummary,
  type InvitePreview,
  type GroupMutationResult,
  type CreateGroupRequestDTO,
  type CreateInviteRequestDTO,
} from '../../../../shared/domain/group';
import type { Page } from '../../../../shared/domainTypes';
import type { GroupRow } from '../dao/group.dao';
import {
  alreadyMember,
  creatorOnly,
  duplicateGroup,
  memberLimitExceeded,
  missing,
  unfinishedGroupRounds,
  unfinishedRounds,
} from '../exception/group.exception';
import { GroupRepository } from '../repository/group.repository';

@Injectable()
export class GroupService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(GroupRepository)
    private readonly repository: GroupRepository,
    @Inject(AuthorizationService)
    private readonly authorization: AuthorizationService,
  ) {}

  private groupDTO(row: GroupRow): GroupSummary {
    return {
      id: row.id,
      name: row.name,
      creatorId: row.creator_id,
      createdAt: Number(row.created_at),
    };
  }

  private async memberGroup(client: Database, groupId: string, userId: string) {
    const row = await this.repository.findMemberGroup(client, groupId, userId);
    if (!row) throw missing();
    return row;
  }

  async requireGroupMembership(
    client: Database,
    groupId: string,
    userId: string,
  ): Promise<GroupSummary> {
    return this.groupDTO(await this.memberGroup(client, groupId, userId));
  }

  async listGroups(
    access: Identity,
    query: SearchPageQuery,
  ): Promise<Page<GroupListItem>> {
    const { limit, cursor, search } = query;
    return this.prisma.withDatabaseConnection(async (client) => {
      const account = await this.authorization.requireAccount(client, access);
      const page = pageOf(
        await this.repository.findGroups(
          client,
          account.id,
          search,
          cursor,
          limit,
        ),
        limit,
        this.groupDTO,
      );
      if (!page.items.length) return { ...page, items: [] };
      const memberIds = new Set(
        page.items.flatMap((group) => group.member_ids),
      );
      const profiles = new Map(
        (await getActiveUserProfiles(client, [...memberIds])).map((profile) => [
          profile.userId,
          profile,
        ]),
      );
      return {
        ...page,
        items: page.items.map((group) => {
          const members = group.member_ids.flatMap((id) => {
            const profile = profiles.get(id);
            return profile ? [profile] : [];
          });
          return {
            ...this.groupDTO(group),
            memberCount: members.length,
            memberPreview: members.slice(0, 5),
          };
        }),
      };
    });
  }

  async getGroup(access: Identity, groupId: string): Promise<GroupDetail> {
    return this.prisma.withDatabaseConnection(async (client) => {
      const account = await this.authorization.requireAccount(client, access);
      const rows = await this.repository.findGroupWithMembers(client, groupId);
      if (!rows.some((row) => row.user_id === account.id)) throw missing();
      const group = rows[0];
      const members = rows.map((row) => ({
        userId: row.user_id,
        displayName: row.display_name,
        excludedAt: null,
      }));
      const invites =
        group.creator_id === account.id
          ? await this.repository.findActiveInvites(
              client,
              groupId,
              nowSeconds(),
            )
          : [];
      return {
        ...this.groupDTO(group),
        isCreator: group.creator_id === account.id,
        members,
        invites: invites.map((row) => ({
          id: row.id,
          expiresAt: Number(row.expires_at),
        })),
      };
    });
  }

  async createGroup(
    access: Identity,
    key: string,
    body: CreateGroupRequestDTO,
    captureAudience?: (userIds: string[]) => void,
  ): Promise<GroupMutationResult> {
    if (!isUUID(key, '7'))
      throw new GroupException(groupErrors.GROUP_CREATION_KEY_REQUIRED);
    const id = key.toLowerCase();
    return this.prisma.withDatabaseConnection(async (client) => {
      const account = await this.authorization.requireAccount(client, access);
      try {
        await this.repository.insertGroup(
          client,
          id,
          account.id,
          body.name,
          nowSeconds(),
        );
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          ((error.code === '23505' &&
            'constraint' in error &&
            error.constraint === 'groups_pkey') ||
            error.code === 'P2002')
        )
          throw duplicateGroup();
        throw error;
      }
      captureAudience?.([account.id]);
      return { id };
    });
  }

  async leaveGroup(
    access: Identity,
    key: string,
    groupId: string,
    captureAudience?: (userIds: string[]) => void,
  ): Promise<GroupMutationResult> {
    let audience: string[] = [];
    let userId: string;
    const result = await this.prisma.withWriteTransaction(
      async (client) => {
        const digest = mutationDigest(key, { groupId });
        const group = await this.repository.findGroupDeparture(
          client,
          groupId,
          userId,
          key,
        );
        audience = group.member_ids;
        const replay = mutationResult<GroupMutationResult>(group, digest);
        if (replay) return replay;
        if (!group.user_id) throw missing();
        const isCreator = group.creator_id === userId;
        if (group.has_unfinished)
          throw isCreator ? unfinishedGroupRounds() : unfinishedRounds();
        await this.repository.leaveGroup(
          client,
          groupId,
          userId,
          nowSeconds(),
          isCreator,
          key,
          digest,
        );
        return { id: groupId };
      },
      async (client) => {
        userId = (await this.authorization.requireAccount(client, access)).id;
      },
    );
    captureAudience?.(audience);
    return result;
  }

  async createInvite(
    access: Identity,
    key: string,
    groupId: string,
    body: CreateInviteRequestDTO,
    captureAudience?: (userIds: string[]) => void,
  ): Promise<GroupMutationResult> {
    return this.prisma.withDatabaseConnection(async (client) => {
      const account = await this.authorization.requireAccount(client, access);
      const digest = mutationDigest(key, { groupId, ...body });
      const group = await this.repository.findInviteMutation(
        client,
        groupId,
        account.id,
        key,
        'invite.create',
      );
      const replay = mutationResult<GroupMutationResult>(group, digest);
      captureAudience?.([account.id]);
      if (replay) return replay;
      if (!group.user_id) throw missing();
      if (group.creator_id !== account.id) throw creatorOnly();
      const id = randomUUID(),
        token = createInviteToken(),
        now = nowSeconds();
      try {
        if (
          !(await this.repository.insertInvite(
            client,
            id,
            groupId,
            account.id,
            createHash('sha256').update(token).digest('hex'),
            now,
            now + 7 * 86400,
            key,
            digest,
            body.replaceInviteId ?? null,
          ))
        )
          throw missing();
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === '23505' &&
          'constraint' in error &&
          error.constraint === 'mutation_requests_pkey'
        ) {
          const concurrent = mutationResult<GroupMutationResult>(
            await this.repository.findInviteMutation(
              client,
              groupId,
              account.id,
              key,
              'invite.create',
            ),
            digest,
          );
          if (concurrent) return concurrent;
        }
        throw error;
      }
      return { id, inviteId: id, sharePath: `/invites/${token}` };
    });
  }

  async revokeInvite(
    access: Identity,
    key: string,
    groupId: string,
    inviteId: string,
    captureAudience?: (userIds: string[]) => void,
  ): Promise<GroupMutationResult> {
    return this.prisma.withDatabaseConnection(async (client) => {
      const account = await this.authorization.requireAccount(client, access);
      const digest = mutationDigest(key, { groupId, inviteId });
      const group = await this.repository.findInviteMutation(
        client,
        groupId,
        account.id,
        key,
        'invite.revoke',
      );
      const replay = mutationResult<GroupMutationResult>(group, digest);
      captureAudience?.([account.id]);
      if (replay) return replay;
      if (!group.user_id) throw missing();
      if (group.creator_id !== account.id) throw creatorOnly();
      try {
        if (
          !(await this.repository.revokeInvite(
            client,
            groupId,
            inviteId,
            nowSeconds(),
            account.id,
            key,
            digest,
          ))
        )
          throw missing();
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === '23505' &&
          'constraint' in error &&
          error.constraint === 'mutation_requests_pkey'
        ) {
          const concurrent = mutationResult<GroupMutationResult>(
            await this.repository.findInviteMutation(
              client,
              groupId,
              account.id,
              key,
              'invite.revoke',
            ),
            digest,
          );
          if (concurrent) return concurrent;
        }
        throw error;
      }
      return { id: inviteId };
    });
  }

  private async validInvite(client: Database, token: string, userId: string) {
    if (!isInviteToken(token)) throw missing();
    const row = await this.repository.findValidInvite(
      client,
      createHash('sha256').update(token).digest('hex'),
      userId,
      nowSeconds(),
    );
    if (!row) throw missing();
    return row;
  }

  async getInvite(access: Identity, token: string): Promise<InvitePreview> {
    return this.prisma.withDatabaseConnection(async (client) => {
      const account = await this.authorization.requireAccount(client, access);
      const row = await this.validInvite(client, token, account.id);
      return {
        groupId: row.group_id,
        groupName: row.name,
        isMember: row.is_member,
        expiresAt: Number(row.expires_at),
      };
    });
  }

  async acceptInvite(
    access: Identity,
    key: string,
    token: string,
    captureAudience?: (userIds: string[]) => void,
  ): Promise<GroupMutationResult> {
    return this.prisma.withDatabaseConnection(async (client) => {
      const account = await this.authorization.requireAccount(client, access);
      if (!isInviteToken(token)) throw missing();
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const digest = mutationDigest(key, { tokenHash });
      const row = await this.repository.findInviteAcceptance(
        client,
        tokenHash,
        account.id,
        nowSeconds(),
        key,
      );
      const replay = mutationResult<GroupMutationResult>(row, digest);
      if (replay) {
        captureAudience?.([]);
        return replay;
      }
      if (!row.group_id) throw missing();
      if (row.is_member) throw alreadyMember();
      return this.prisma.withWriteTransaction(async (client) => {
        const joined = await this.repository.joinGroup(
          client,
          tokenHash,
          account.id,
          nowSeconds(),
          key,
          digest,
          MAX_GROUP_MEMBERS,
        );
        if (!joined.actor_active)
          throw new GroupException(groupErrors.UNAUTHORIZED);
        if (!joined.group_id) throw missing();
        if (joined.is_member) throw alreadyMember();
        if (joined.member_count >= MAX_GROUP_MEMBERS)
          throw memberLimitExceeded();
        if (!joined.joined) throw alreadyMember();
        captureAudience?.([...joined.member_ids, account.id]);
        return { id: joined.group_id };
      });
    });
  }
}
