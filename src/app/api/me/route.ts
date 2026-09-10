import { NextRequest, NextResponse } from 'next/server'
import { ACCESS_TOKEN_COOKIE_NAME, readAccessToken } from '../../../lib/auth'
import { getAccount } from '../../../lib/authorization'
import { errorResponse } from '../../../lib/errors'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  try {
    const account = await getAccount(readAccessToken(request.cookies.get(ACCESS_TOKEN_COOKIE_NAME)?.value), true)
    const { id, displayName, email, profileImageUrl, purpose, deletedAt, onboardingCompletedAt, bankName, accountNumber, accountHolder } = account
    const bankAccount = bankName && accountNumber && accountHolder ? { bankName, accountNumber, accountHolder } : null
    return NextResponse.json({ data: { id, displayName, email, profileImageUrl, purpose, deletedAt, onboardingCompletedAt, bankAccount } }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    return errorResponse(error)
  }
}
