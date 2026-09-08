import { NextRequest, NextResponse } from 'next/server'
import { ACCESS_TOKEN_COOKIE_NAME, readAccessToken } from '../../../../lib/auth'
import { updateBankAccount } from '../../../../lib/auth-store'
import { AppError, errorResponse } from '../../../../lib/errors'
import { readJsonBody } from '../../../../lib/http'

export const runtime = 'nodejs'

export async function PUT(request: NextRequest) {
  try {
    if (request.headers.get('origin') !== request.nextUrl.origin) throw new AppError(403, 'forbidden', '허용되지 않은 요청입니다')
    const input = await readJsonBody(request, 16384)
    const result = await updateBankAccount(readAccessToken(request.cookies.get(ACCESS_TOKEN_COOKIE_NAME)?.value), request.headers.get('Idempotency-Key') ?? '', input)
    return NextResponse.json({ data: result }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    return errorResponse(error)
  }
}
