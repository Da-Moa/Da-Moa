
export type UserAccountState = {
  id: string
  displayName: string | null
  email: string | null
  profileImageUrl: string | null
  bankName: string | null
  accountNumber: string | null
  formattedAccountNumber: string | null
  accountHolder: string | null
  bankCode: string | null
  bankVerifiedAt: number | null
  bankVersion: number
  updatedAt: number
  deletedAt: number | null
  onboardingCompletedAt: number | null
}

export type Account = {
  id: string; displayName: string | null; email: string | null; profileImageUrl: string | null;
  onboardingCompletedAt: number | null; deletedAt: number | null; purpose: 'app' | 'onboarding';
  bankVersion: number;
  bankAccount: { bankCode: string | null; bankName: string; accountNumber: string; formattedAccountNumber: string | null; accountHolder: string; verifiedAt: number | null } | null;
}

export type BankAccountResponseDTO = { id: string; bankVersion: number }
export type OnboardingResponseDTO = { id: string; returnTo: string; accessToken: string }
export type WithdrawResponseDTO = { ok: true }
export type ActiveUserProfile = { userId: string; displayName: string; profileImageUrl: string | null }
export type SignInUserDTO = Pick<UserAccountState, 'id' | 'deletedAt' | 'onboardingCompletedAt'>

export type { BankAccountRequestDTO, OnboardingRequestDTO } from '../req/user.request.dto'
