import { NextRequest, NextResponse } from 'next/server'
import { ACCESS_TOKEN_COOKIE_NAME, readAccessToken } from '../../../lib/auth'
import { getAccount } from '../../../lib/authorization'
import { errorResponse } from '../../../lib/errors'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  try {
    const account = await getAccount(readAccessToken(request.cookies.get(ACCESS_TOKEN_COOKIE_NAME)?.value), true)
    const { bankName, accountNumber, accountHolder, ...profile } = account
    const bankAccount = bankName && accountNumber && accountHolder ? { bankName, accountNumber, accountHolder } : null
    return NextResponse.json({ data: { ...profile, bankAccount } }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    return errorResponse(error)
  }
}
