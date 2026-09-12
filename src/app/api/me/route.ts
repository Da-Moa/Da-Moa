import { NextRequest, NextResponse } from 'next/server'
import { ACCESS_TOKEN_COOKIE_NAME, readAccessToken } from '../../../lib/auth'
import { requireAccount } from '../../../lib/authorization'
import { withReadTransaction } from '../../../lib/db'
import { errorResponse } from '../../../lib/errors'
import { getOpenBankingStatus } from '../../../lib/openbanking-store'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  try {
    const data = await withReadTransaction(async client => {
      const account = await requireAccount(client, readAccessToken(request.cookies.get(ACCESS_TOKEN_COOKIE_NAME)?.value), true)
      const { id, displayName, email, profileImageUrl, purpose, deletedAt, onboardingCompletedAt, bankName, accountNumber, accountHolder, bankCode, bankVerifiedAt, bankVersion } = account
      const bankAccount = bankName && accountNumber && accountHolder ? { bankName, accountNumber, accountHolder, bankCode, verifiedAt: bankVerifiedAt } : null
      return { id, displayName, email, profileImageUrl, purpose, deletedAt, onboardingCompletedAt, bankAccount, bankVersion, openBanking: await getOpenBankingStatus(client, id) }
    })
    return NextResponse.json({ data }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    return errorResponse(error)
  }
}
