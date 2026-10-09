import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '../../../global/database/prisma.service';
import { userErrors } from '../code/user.error.code';
import { UserException } from '../exception/user.exception';
import {
  currentTimestamp,
  type AccessToken,
  type KakaoProfile,
} from '../../../global/auth/authUtil';
import { TokenService } from '../../../global/auth/service/token.service';
import {
  AuthorizationService,
  type Account as AuthorizedAccount,
} from '../../../global/auth/service/authorization.service';
import { mutationDigest, type Database } from '../../../global/util';
import { getUnfinishedUserRounds } from '../../settle/repository';
import {
  bankDisplayName,
  normalizeBankAccountInput,
  type Account,
  type BankAccountInput,
  type BankAccountRequestDTO,
  type OnboardingRequestDTO,
  type SignInUserDTO,
  type BankAccountResponseDTO,
} from '../../../../shared/domain/user';
import {
  alreadyOnboarded,
  bankAccountConflict,
  rejoinConfirmationRequired,
  unfinishedRounds,
} from '../exception/user.exception';
import { UserRepository } from '../repository/user.repository';

@Injectable()
export class UserService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(UserRepository)
    private readonly repository: UserRepository,
    @Inject(AuthorizationService)
    private readonly authorization: AuthorizationService,
    @Inject(TokenService) private readonly tokens: TokenService,
  ) {}

  private assertBankVersion(
    account: AuthorizedAccount,
    expectedVersion: number,
  ) {
    if (account.bankVersion !== expectedVersion) throw bankAccountConflict();
  }

  private assertOnboarding(account: AuthorizedAccount, bank: BankAccountInput) {
    if (account.purpose !== 'onboarding') throw alreadyOnboarded();
    if (account.deletedAt !== null && !bank.confirmRejoin)
      throw rejoinConfirmationRequired();
    this.assertBankVersion(account, bank.expectedBankVersion);
  }

  async completeOnboarding(
    access: AccessToken | null,
    input: OnboardingRequestDTO,
  ) {
    const bank = normalizeBankAccountInput(input);
    return this.prisma.withDatabaseConnection(async (client) => {
      const account = await this.authorization.requireAccount(
        client,
        access,
        true,
      );
      this.assertOnboarding(account, bank);
      const now = currentTimestamp();
      const session = this.tokens.issueTokens(account.id, 'app', now);
      if (
        !(await this.repository.saveOnboarding(
          client,
          account.id,
          bank,
          now,
          account.updatedAt,
        ))
      )
        throw bankAccountConflict();
      // Memberships deliberately stay inactive after rejoining.
      return session;
    });
  }

  async updateBankAccount(
    access: AccessToken | null,
    requestKey: string,
    input: BankAccountRequestDTO,
  ): Promise<BankAccountResponseDTO> {
    return this.prisma.withDatabaseConnection(async (client) => {
      const account = await this.authorization.requireAccount(client, access);
      const bank = normalizeBankAccountInput(input);
      mutationDigest(requestKey, null);
      if (
        !(await this.repository.saveBankAccount(
          client,
          account.id,
          bank,
          currentTimestamp(),
        ))
      )
        throw bankAccountConflict();
      return { id: account.id, bankVersion: bank.expectedBankVersion + 1 };
    });
  }

  withdrawAccount(access: AccessToken | null) {
    return this.prisma.withWriteTransaction(async (client) => {
      const account = await this.authorization.requireAccount(client, access);
      const rows = await getUnfinishedUserRounds(client, account.id);
      if (rows.length) throw unfinishedRounds(rows);
      const result = await this.repository.softDeleteUser(
        client,
        account.id,
        currentTimestamp(),
      );
      if (result.unfinishedRounds.length)
        throw unfinishedRounds(result.unfinishedRounds);
      if (!result.deleted) throw new UserException(userErrors.UNAUTHORIZED);
      return { ok: true, userId: account.id, groupIds: result.groupIds };
    });
  }

  getMe(access: AccessToken | null): Promise<Account> {
    return this.prisma.withDatabaseConnection(async (client) => {
      const account = await this.authorization.requireAccount(
        client,
        access,
        true,
      );
      const {
        id,
        displayName,
        email,
        profileImageUrl,
        purpose,
        deletedAt,
        onboardingCompletedAt,
        bankName,
        accountNumber,
        formattedAccountNumber,
        accountHolder,
        bankCode,
        bankVerifiedAt,
        bankVersion,
      } = account;
      const bankAccount =
        bankName && accountNumber && accountHolder
          ? {
              bankName: bankDisplayName(bankName),
              accountNumber,
              formattedAccountNumber,
              accountHolder,
              bankCode,
              verifiedAt: bankVerifiedAt,
            }
          : null;
      return {
        id,
        displayName,
        email,
        profileImageUrl,
        purpose,
        deletedAt,
        onboardingCompletedAt,
        bankAccount,
        bankVersion,
      };
    });
  }

  async findOrCreateKakaoUser(
    client: Database,
    providerSubject: string,
    profile: KakaoProfile,
    now: number,
  ): Promise<SignInUserDTO> {
    const row = await this.repository.findOrCreateKakaoUser(
      client,
      providerSubject,
      profile,
      now,
    );
    // A concurrent first INSERT can win outside this statement's read snapshot.
    if (!row) throw new UserException(userErrors.SIGN_IN_CONFLICT);
    return {
      id: row.id,
      deletedAt: row.deleted_at === null ? null : Number(row.deleted_at),
      onboardingCompletedAt:
        row.onboarding_completed_at === null
          ? null
          : Number(row.onboarding_completed_at),
    };
  }

  async createTestOnboardingUser(
    client: Database,
    id: string,
    now: number,
  ): Promise<void> {
    await this.repository.insertTestOnboardingUser(client, id, now);
  }

  async getTestSignInUser(
    client: Database,
    id: string,
    providerSubject: string,
  ): Promise<string | undefined> {
    return this.repository.findTestSignInUser(client, id, providerSubject);
  }
}
