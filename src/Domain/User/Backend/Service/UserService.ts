import 'server-only'
import { createHmac } from 'node:crypto'
import { currentTimestamp, issueTokens, requireAccount, type AccessToken, type KakaoProfile } from '../../../../Global/Auth/Backend'
import { withDatabaseConnection, withWriteTransaction, objectBody, replayMutation, saveMutation, type Database } from '../../../../Global/Util/Backend'
import { endUserMemberships } from '../../../Group/Backend'
import { getUnfinishedUserRounds } from '../../../Settle/Backend'
import { normalizeBankAccountInput, type Account, type BankAccountInput, type UserAccountState, type SignInUserDTO, type BankAccountResponseDTO } from '../../Shared'
import { alreadyOnboarded, bankAccountConflict, rejoinConfirmationRequired, unfinishedRounds } from '../Exception/UserException'
import * as repository from '../Repository/UserRepository'

type AuthorizedAccount = UserAccountState & { purpose: 'app' | 'onboarding' }
function assertBankVersion(account: AuthorizedAccount, expectedVersion: number) {
  if (account.bankVersion !== expectedVersion) throw bankAccountConflict()
}

function assertOnboarding(account: AuthorizedAccount, bank: BankAccountInput) {
  if (account.purpose !== 'onboarding') throw alreadyOnboarded()
  if (account.deletedAt !== null && !bank.confirmRejoin) throw rejoinConfirmationRequired()
  assertBankVersion(account, bank.expectedBankVersion)
}

export async function completeOnboarding(access: AccessToken | null, input: unknown) {
  const bank = normalizeBankAccountInput(objectBody(input), { onboarding: true })
  return withDatabaseConnection(async (client) => {
    const account = await requireAccount(client, access, true)
    assertOnboarding(account, bank)
    const now = currentTimestamp()
    const session = issueTokens(account.id, 'app', now)
    if (!await repository.saveOnboarding(client, account.id, bank, now, account.updatedAt)) throw bankAccountConflict()
    // Memberships deliberately stay inactive after rejoining.
    return session
  })
}

export async function updateBankAccount(access: AccessToken | null, requestKey: string, input: unknown): Promise<BankAccountResponseDTO> {
  const bank = normalizeBankAccountInput(objectBody(input))
  const operation = 'bank-account.update'
  const initial = await withWriteTransaction(async client => {
    const account = await requireAccount(client, access)
    const secret = process.env.AUTH_JWT_SECRET
    if (!secret || Buffer.byteLength(secret) < 32) throw new Error('AUTH_JWT_SECRET must be at least 32 bytes')
    const fingerprint = createHmac('sha256', secret).update(JSON.stringify(['PUT /api/me/bank-account', account.id,
      bank.bankCode, bank.accountNumber, '', bank.accountHolder, bank.expectedBankVersion, false])).digest('hex')
    const prior = await replayMutation<{ id: string; bankVersion: number }>(client, account.id, operation, requestKey, fingerprint)
    return { ...prior, fingerprint }
  })
  if (initial.result) return initial.result
  return withWriteTransaction(async client => {
    // Replay precedes the version assertion: a concurrent copy may already have committed this exact request.
    const current = await requireAccount(client, access)
    const prior = await replayMutation<{ id: string; bankVersion: number }>(client, current.id, operation, requestKey, initial.fingerprint)
    if (prior.result) return prior.result
    assertBankVersion(current, bank.expectedBankVersion)
    const now = currentTimestamp()
    await repository.saveBankAccount(client, current.id, bank, now)
    const result = { id: current.id, bankVersion: bank.expectedBankVersion + 1 }
    await saveMutation(client, current.id, operation, requestKey, prior.digest, current.id, result)
    return result
  })
}

export function withdrawAccount(access: AccessToken | null) {
  return withWriteTransaction(async (client) => {
    const account = await requireAccount(client, access)
    const rows = await getUnfinishedUserRounds(client, account.id)
    if (rows.length) throw unfinishedRounds(rows)
    const now = currentTimestamp()
    const groupIds = await endUserMemberships(client, account.id, now)
    await repository.softDeleteUser(client, account.id, now)
    return { ok: true, userId: account.id, groupIds }
  })
}

export async function getUserAccountState(client: Database, userId: string): Promise<UserAccountState | null> {
  const row = await repository.findUser(client, userId)
  if (!row) return null
  return {
    id: row.id, displayName: row.display_name, email: row.email, profileImageUrl: row.profile_image_url,
    bankName: row.bank_name, accountNumber: row.account_number, formattedAccountNumber: row.account_number_formatted,
    accountHolder: row.account_holder, bankCode: row.bank_code,
    bankVerifiedAt: row.bank_verified_at === null ? null : Number(row.bank_verified_at), bankVersion: Number(row.bank_version),
    updatedAt: Number(row.updated_at),
    deletedAt: row.deleted_at === null ? null : Number(row.deleted_at),
    onboardingCompletedAt: row.onboarding_completed_at === null ? null : Number(row.onboarding_completed_at),
  }
}

export function getMe(access: AccessToken | null): Promise<Account> {
  return withDatabaseConnection(async client => {
    const account = await requireAccount(client, access, true)
    const { id, displayName, email, profileImageUrl, purpose, deletedAt, onboardingCompletedAt, bankName, accountNumber, formattedAccountNumber, accountHolder, bankCode, bankVerifiedAt, bankVersion } = account
    const bankAccount = bankName && accountNumber && accountHolder ? { bankName, accountNumber, formattedAccountNumber, accountHolder, bankCode, verifiedAt: bankVerifiedAt } : null
    return { id, displayName, email, profileImageUrl, purpose, deletedAt, onboardingCompletedAt, bankAccount, bankVersion }
  })
}

export async function upsertKakaoUser(client: Database, providerSubject: string, profile: KakaoProfile, now: number): Promise<SignInUserDTO> {
  const row = await repository.upsertKakaoUser(client, providerSubject, profile, now)
  return { id: row.id, deletedAt: row.deleted_at === null ? null : Number(row.deleted_at), onboardingCompletedAt: row.onboarding_completed_at === null ? null : Number(row.onboarding_completed_at) }
}

export async function createTestOnboardingUser(client: Database, id: string, now: number): Promise<void> {
  await repository.insertTestOnboardingUser(client, id, now)
}

export async function getTestSignInUser(client: Database, id: string, providerSubject: string): Promise<string | undefined> {
  return repository.findTestSignInUser(client, id, providerSubject)
}
