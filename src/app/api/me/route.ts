import { NextRequest, NextResponse } from 'next/server'
import { readRequestAccessToken } from '../../../lib/auth'
import { requireAccount } from '../../../lib/authorization'
import { withReadTransaction } from '../../../lib/db'
import { errorResponse } from '../../../lib/errors'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  try {
    const data = await withReadTransaction(async client => {
      const account = await requireAccount(client, readRequestAccessToken(request), true)
      const { id, displayName, email, profileImageUrl, purpose, deletedAt, onboardingCompletedAt, bankName, accountNumber, formattedAccountNumber, accountHolder, bankCode, bankVerifiedAt, bankVersion } = account
      const bankAccount = bankName && accountNumber && accountHolder ? { bankName, accountNumber, formattedAccountNumber, accountHolder, bankCode, verifiedAt: bankVerifiedAt } : null
      return { id, displayName, email, profileImageUrl, purpose, deletedAt, onboardingCompletedAt, bankAccount, bankVersion }
    })
    return NextResponse.json({ data }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    return errorResponse(error)
  }
}
