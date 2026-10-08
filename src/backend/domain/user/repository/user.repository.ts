import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '../../../global/database/prisma.service';
import { randomUUID } from 'node:crypto';
import type { Database } from '../../../global/util';
import type { KakaoProfile } from '../../../global/auth';
import type { BankAccountInput } from '../../../../shared/domain/user';
import type { SignInUserRow } from '../dao/user.dao';
import { endUserMembershipsSql } from '../../group/repository';
import { unfinishedUserRoundsSql } from '../../settle/repository';
import type { UnfinishedUserRound } from '../../../../shared/domain/settle';

@Injectable()
export class UserRepository {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
  ) {}

  async findOrCreateKakaoUser(
    client: Database,
    providerSubject: string,
    profile: KakaoProfile,
    now: number,
  ): Promise<SignInUserRow | undefined> {
    const { rows } = await this.prisma.query<SignInUserRow>(
      client,
      `
    WITH existing AS MATERIALIZED (
      SELECT id, deleted_at, onboarding_completed_at
      FROM users WHERE provider = 'kakao' AND provider_subject = $2
    ), inserted AS (
      INSERT INTO users(id, provider, provider_subject, display_name, email, profile_image_url, created_at, updated_at)
      SELECT $1, 'kakao', $2, $3, $4, $5, $6, $6
      WHERE NOT EXISTS (SELECT 1 FROM existing)
      ON CONFLICT (provider, provider_subject) DO NOTHING
      RETURNING id, deleted_at, onboarding_completed_at
    )
    SELECT id, deleted_at, onboarding_completed_at FROM existing
    UNION ALL
    SELECT id, deleted_at, onboarding_completed_at FROM inserted
    `,
      [
        randomUUID(),
        providerSubject,
        profile.displayName,
        profile.email,
        profile.profileImageUrl,
        now,
      ],
    );
    return rows[0];
  }

  async insertTestOnboardingUser(client: Database, id: string, now: number) {
    await client.prisma.users.create({
      data: {
        id,
        provider: 'test',
        provider_subject: `da-moa:test-only:onboarding:${id}`,
        display_name: '민지',
        created_at: BigInt(now),
        updated_at: BigInt(now),
      },
    });
  }

  async findTestSignInUser(
    client: Database,
    id: string,
    providerSubject: string,
  ): Promise<string | undefined> {
    const row = await client.prisma.users.findFirst({
      where: {
        id,
        provider: 'test',
        provider_subject: providerSubject,
        deleted_at: null,
        onboarding_completed_at: { not: null },
        bank_name: { not: null },
        account_number: { not: null },
        account_holder: { not: null },
      },
      select: { id: true },
    });
    return row?.id;
  }

  async saveOnboarding(
    client: Database,
    userId: string,
    bank: BankAccountInput,
    now: number,
    expectedUpdatedAt: number,
  ) {
    try {
      await client.prisma.users.update({
        where: {
          id: userId,
          updated_at: BigInt(expectedUpdatedAt),
          bank_version: bank.expectedBankVersion,
          OR: [
            { deleted_at: { not: null } },
            { onboarding_completed_at: null },
          ],
        },
        select: { id: true },
        data: {
          bank_name: bank.bankName,
          account_number: bank.accountNumber,
          account_holder: bank.accountHolder,
          bank_updated_at: BigInt(now),
          deleted_at: null,
          onboarding_completed_at: BigInt(now),
          updated_at: BigInt(now),
          bank_code: bank.bankCode,
          account_number_formatted: bank.formattedAccountNumber,
          bank_verified_at: null,
          bank_verification_tran_id: null,
          bank_version: { increment: 1 },
        },
      });
      return true;
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'P2025'
      )
        return false;
      throw error;
    }
  }

  async saveBankAccount(
    client: Database,
    userId: string,
    bank: BankAccountInput,
    now: number,
  ) {
    const { rowCount } = await this.prisma.query(
      client,
      `UPDATE users SET bank_name = $2, account_number = $3, account_holder = $4,
      bank_updated_at = $5, updated_at = $5, bank_code = $6, account_number_formatted = $7,
      bank_verified_at = CASE WHEN bank_code=$6 AND account_number=$3 AND account_holder=$4 THEN bank_verified_at ELSE NULL END,
      bank_verification_tran_id = CASE WHEN bank_code=$6 AND account_number=$3 AND account_holder=$4 THEN bank_verification_tran_id ELSE NULL END,
      bank_version = bank_version + 1 WHERE id = $1 AND bank_version = $8
        AND deleted_at IS NULL AND onboarding_completed_at IS NOT NULL`,
      [
        userId,
        bank.bankName,
        bank.accountNumber,
        bank.accountHolder,
        now,
        bank.bankCode,
        bank.formattedAccountNumber,
        bank.expectedBankVersion,
      ],
    );
    return rowCount === 1;
  }

  async softDeleteUser(client: Database, userId: string, now: number) {
    const { rows } = await this.prisma.query<{
      deleted: boolean;
      unfinishedRounds: UnfinishedUserRound[];
      groupIds: string[];
    }>(
      client,
      `
    WITH unfinished AS MATERIALIZED (${unfinishedUserRoundsSql}), withdrawn AS (
      UPDATE users SET deleted_at = $2, updated_at = $2
      WHERE id = $1 AND deleted_at IS NULL AND onboarding_completed_at IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM unfinished)
      RETURNING id
    ), departed AS (${endUserMembershipsSql})
    SELECT EXISTS(SELECT 1 FROM withdrawn) AS deleted,
      COALESCE((SELECT jsonb_agg(unfinished) FROM unfinished), '[]'::jsonb) AS "unfinishedRounds",
      ARRAY(SELECT group_id FROM departed) AS "groupIds"
  `,
      [userId, now],
    );
    return rows[0];
  }
}
