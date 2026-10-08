import { Injectable, Inject } from '@nestjs/common';
import { AccountStateRepository } from '../../../domain/user/repository/accountState.repository';
import { PrismaService } from '../../database/prisma.service';
import type { UserAccountState } from '../../../../shared/domain/user';
import type { AccessToken } from '../authUtil';
import { type Database } from '../../database/db';
import { AppError } from '../../apiPayload/errors';

export type Account = UserAccountState & { purpose: 'app' | 'onboarding' };

@Injectable()
export class AuthorizationService {
  constructor(
    @Inject(AccountStateRepository)
    private readonly accounts: AccountStateRepository,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async requireAccount(
    client: Database,
    access: AccessToken | null,
    allowOnboarding = false,
  ): Promise<Account> {
    if (!access) throw new AppError(401, 'unauthorized', '로그인이 필요합니다');
    const purpose = access.purpose ?? 'app';
    const row = await this.accounts.findState(client, access.userId);
    if (
      !row ||
      (purpose === 'app' && row.deletedAt !== null) ||
      (purpose === 'onboarding' &&
        row.deletedAt === null &&
        row.onboardingCompletedAt !== null)
    ) {
      throw new AppError(401, 'unauthorized', '로그인이 필요합니다');
    }
    if (
      !allowOnboarding &&
      (purpose !== 'app' || row.onboardingCompletedAt === null)
    ) {
      throw new AppError(
        403,
        'onboarding_required',
        '계좌 등록과 가입 완료가 필요합니다',
      );
    }
    return { ...row, purpose };
  }

  async getAccount(access: AccessToken | null, allowOnboarding = false) {
    if (!access) throw new AppError(401, 'unauthorized', '로그인이 필요합니다');
    return this.prisma.withReadTransaction((client) =>
      this.requireAccount(client, access, allowOnboarding),
    );
  }
}
