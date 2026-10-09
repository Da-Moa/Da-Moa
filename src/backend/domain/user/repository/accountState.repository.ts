import { Injectable } from '@nestjs/common';
import type { Database } from '../../../global/database/db';
import type { UserAccountState } from '../../../../shared/domain/user';

@Injectable()
export class AccountStateRepository {
  async findState(
    client: Database,
    userId: string,
  ): Promise<UserAccountState | null> {
    // Keep authorization reads independent; findUnique batches concurrent lookups.
    const row = await client.prisma.users.findFirst({
      where: { id: userId },
      select: {
        id: true,
        display_name: true,
        email: true,
        profile_image_url: true,
        bank_name: true,
        account_number: true,
        account_number_formatted: true,
        account_holder: true,
        bank_code: true,
        bank_verified_at: true,
        bank_version: true,
        updated_at: true,
        deleted_at: true,
        onboarding_completed_at: true,
      },
    });
    if (!row) return null;
    return {
      id: row.id,
      displayName: row.display_name,
      email: row.email,
      profileImageUrl: row.profile_image_url,
      bankName: row.bank_name,
      accountNumber: row.account_number,
      formattedAccountNumber: row.account_number_formatted,
      accountHolder: row.account_holder,
      bankCode: row.bank_code,
      bankVerifiedAt:
        row.bank_verified_at === null ? null : Number(row.bank_verified_at),
      bankVersion: Number(row.bank_version),
      updatedAt: Number(row.updated_at),
      deletedAt: row.deleted_at === null ? null : Number(row.deleted_at),
      onboardingCompletedAt:
        row.onboarding_completed_at === null
          ? null
          : Number(row.onboarding_completed_at),
    };
  }
}
