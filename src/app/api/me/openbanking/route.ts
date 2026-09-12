import { NextRequest, NextResponse } from 'next/server'
import { ACCESS_TOKEN_COOKIE_NAME, readAccessToken } from '../../../../lib/auth'
import { AppError, errorResponse } from '../../../../lib/errors'
import { readJsonBody } from '../../../../lib/http'
import { startOpenBanking } from '../../../../lib/openbanking-store'
import { createOpenBankingCallbackCookie, OPENBANKING_CALLBACK_COOKIE, openBankingCallbackCookieOptions } from '../../../../lib/openbanking-callback'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  try {
    if (request.headers.get('origin') !== request.nextUrl.origin) throw new AppError(403, 'forbidden', '허용되지 않은 요청입니다')
    const input = await readJsonBody(request, 16384)
    if (!['onboarding', 'settings'].includes(String(input.context)) || Object.keys(input).some(key => !['context', 'returnTo'].includes(key))) {
      throw new AppError(400, 'invalid_input', '인증을 시작할 화면을 확인해 주세요')
    }
    const access = readAccessToken(request.cookies.get(ACCESS_TOKEN_COOKIE_NAME)?.value)
    const result = await startOpenBanking(access, input.context as 'onboarding' | 'settings', input.returnTo)
    const response = NextResponse.json({ data: result }, { headers: { 'Cache-Control': 'private, no-store' } })
    if (result.authorizationUrl) {
      const state = new URL(result.authorizationUrl).searchParams.get('state')!
      response.cookies.set(OPENBANKING_CALLBACK_COOKIE, createOpenBankingCallbackCookie(access!, state), openBankingCallbackCookieOptions())
    }
    return response
  } catch (error) {
    return errorResponse(error)
  }
}
