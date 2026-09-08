import { NextRequest, NextResponse } from 'next/server'
import {
  ACCESS_TOKEN_COOKIE_NAME, REFRESH_TOKEN_COOKIE_NAME, RETURN_TO_COOKIE_NAME,
  authCookieOptions, refreshCookieOptions, readAccessToken, readReturnToCookie,
} from '../../../../lib/auth'
import { completeOnboarding } from '../../../../lib/auth-store'
import { AppError, errorResponse } from '../../../../lib/errors'
import { readJsonBody } from '../../../../lib/http'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  try {
    if (request.headers.get('origin') !== request.nextUrl.origin) throw new AppError(403, 'forbidden', '허용되지 않은 요청입니다')
    const input = await readJsonBody(request, 16384)
    const access = readAccessToken(request.cookies.get(ACCESS_TOKEN_COOKIE_NAME)?.value)
    const returnTo = readReturnToCookie(request.cookies.get(RETURN_TO_COOKIE_NAME)?.value)
    const session = await completeOnboarding(access, input)
    const response = NextResponse.json({ data: { id: session.userId, returnTo } }, { headers: { 'Cache-Control': 'private, no-store' } })
    response.cookies.set(ACCESS_TOKEN_COOKIE_NAME, session.accessToken, authCookieOptions(session.accessMaxAge))
    response.cookies.set(REFRESH_TOKEN_COOKIE_NAME, session.refreshToken, refreshCookieOptions(session.refreshMaxAge))
    response.cookies.set(RETURN_TO_COOKIE_NAME, '', authCookieOptions(0))
    return response
  } catch (error) {
    return errorResponse(error)
  }
}
