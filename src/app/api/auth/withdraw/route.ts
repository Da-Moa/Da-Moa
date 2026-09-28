import { after, NextRequest, NextResponse } from 'next/server'
import {
  ACCESS_TOKEN_COOKIE_NAME,
  authCookieOptions,
  OIDC_COOKIE_NAMES,
  readAccessToken,
  REFRESH_TOKEN_COOKIE_NAME,
  RETURN_TO_COOKIE_NAME,
  refreshCookieOptions,
} from '../../../../lib/auth'
import { withdrawAccount } from '../../../../lib/auth-store'
import { AppError, errorResponse } from '../../../../lib/errors'
import { publishDepartureInvalidation } from '../../../../lib/realtime-server'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  try {
    if (request.headers.get('origin') !== request.nextUrl.origin) throw new AppError(403, 'forbidden', '허용되지 않은 요청입니다')
    const access = readAccessToken(request.cookies.get(ACCESS_TOKEN_COOKIE_NAME)?.value)
    const result = await withdrawAccount(access)
    after(() => publishDepartureInvalidation(result.groupIds))
    const response = NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'private, no-store' } })
    response.cookies.set(ACCESS_TOKEN_COOKIE_NAME, '', authCookieOptions(0))
    response.cookies.set(REFRESH_TOKEN_COOKIE_NAME, '', refreshCookieOptions(0))
    response.cookies.set(RETURN_TO_COOKIE_NAME, '', authCookieOptions(0))
    for (const name of Object.values(OIDC_COOKIE_NAMES)) response.cookies.set(name, '', authCookieOptions(0))
    return response
  } catch (error) {
    return errorResponse(error)
  }
}
