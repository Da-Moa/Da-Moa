import { Injectable, Inject } from '@nestjs/common';
import { UserService } from '../../../domain/user/service/user.service';
import { PrismaService } from '../../database/prisma.service';
import { randomUUID } from 'node:crypto';
import {
  currentTimestamp,
  type KakaoProfile,
  type RefreshToken,
} from '../authUtil';
import { AppError } from '../../apiPayload/errors';
import {
  TEST_ONBOARDING_KEY,
  testAccountForKey,
} from '../../../../shared/testAccounts';

export { issueTokens, refreshTokens, type AuthSession } from './authTokens';
import { issueTokens, refreshTokens } from './authTokens';
@Injectable()
export class AuthService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(UserService)
    private readonly userService: UserService,
  ) {}

  signInKakao(providerSubject: string, profile: KakaoProfile) {
    if (!providerSubject) throw new Error('Kakao subject is required');
    return this.prisma.withDatabaseConnection(async (client) => {
      const now = currentTimestamp();
      const user = await this.userService.findOrCreateKakaoUser(
        client,
        providerSubject,
        profile,
        now,
      );
      const purpose =
        user.deletedAt !== null || user.onboardingCompletedAt === null
          ? 'onboarding'
          : 'app';
      return issueTokens(user.id, purpose, now);
    });
  }

  signInTestAccount(key: unknown) {
    const fixture = testAccountForKey(key);
    if (
      process.env.NODE_ENV === 'production' ||
      (!fixture && key !== TEST_ONBOARDING_KEY)
    ) {
      throw new AppError(404, 'not_found', '테스트 계정을 찾을 수 없습니다');
    }
    return this.prisma.withWriteTransaction(async (client) => {
      if (!fixture) {
        const id = randomUUID(),
          now = currentTimestamp();
        await this.userService.createTestOnboardingUser(client, id, now);
        return issueTokens(id, 'onboarding', now);
      }
      const userId = await this.userService.getTestSignInUser(
        client,
        fixture.id,
        fixture.providerSubject,
      );
      if (!userId)
        throw new AppError(
          404,
          'not_found',
          '테스트 계정을 먼저 시드해 주세요',
        );
      return issueTokens(userId, 'app', currentTimestamp());
    });
  }

  refreshTokens(refresh: RefreshToken) {
    return refreshTokens(refresh);
  }
}
