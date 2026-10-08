import type { AccessToken } from '../../global/auth/native.ts'
import { completeOnboarding, updateBankAccount } from '../../domain/user/index.ts'
import { getAccount } from '../../global/auth/service/authorization.service.ts'

type BankFixture = { bankName: string; accountHolder: string; accountNumber: string; confirmRejoin?: boolean }
const updateVersions = new Map<string, number>()

export async function completeTestOnboarding(access: AccessToken | null, bank: BankFixture) {
  const account = await getAccount(access, true)
  return completeOnboarding(access, { bankCode: '004', accountNumber: bank.accountNumber, accountHolder: bank.accountHolder,
    expectedBankVersion: account.bankVersion, confirmRejoin: bank.confirmRejoin ?? false })
}

export async function updateTestBankAccount(access: AccessToken | null, key: string, bank: BankFixture) {
  const account = await getAccount(access)
  const versionKey = `${account.id}:${key}`
  if (!updateVersions.has(versionKey)) updateVersions.set(versionKey, account.bankVersion)
  return updateBankAccount(access, key, { bankCode: '004', accountNumber: bank.accountNumber, accountHolder: bank.accountHolder,
    expectedBankVersion: updateVersions.get(versionKey) })
}
