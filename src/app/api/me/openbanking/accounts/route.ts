import { NextRequest, NextResponse } from 'next/server'
import { ACCESS_TOKEN_COOKIE_NAME, readAccessToken } from '../../../../../lib/auth'
import { errorResponse } from '../../../../../lib/errors'
import { getRegisteredBankAccounts } from '../../../../../lib/openbanking-store'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  try {
    const accounts = await getRegisteredBankAccounts(readAccessToken(request.cookies.get(ACCESS_TOKEN_COOKIE_NAME)?.value))
    return NextResponse.json({ data: { accounts } }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    return errorResponse(error)
  }
}
