import { NextRequest, NextResponse } from 'next/server'
import {
  ACCESS_TOKEN_COOKIE_NAME, REFRESH_TOKEN_COOKIE_NAME, authCookieOptions,
  refreshCookieOptions, safeReturnTo,
} from '../../../../lib/auth'
import { signInTestAccount } from '../../../../lib/auth-store'
import { AppError, errorResponse } from '../../../../lib/errors'
import { readBytes } from '../../../../lib/http'
import { testLoginGuard } from '../../../../lib/test-accounts'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  try {
    const denied = testLoginGuard(process.env.NODE_ENV, request.nextUrl.hostname, request.headers.get('origin'), request.nextUrl.origin)
    if (denied) throw new AppError(denied, denied === 404 ? 'not_found' : 'forbidden', denied === 404 ? '요청한 API를 찾을 수 없어요' : '허용되지 않은 요청입니다')
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
      throw new AppError(400, 'invalid_input', '올바른 로그인 요청이 필요합니다')
    }
    let form: URLSearchParams
    try { form = new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(await readBytes(request, 4096))) }
    catch (error) { if (error instanceof AppError) throw error; throw new AppError(400, 'invalid_input', '올바른 로그인 요청이 필요합니다') }
    if (form.getAll('key').length !== 1 || form.getAll('returnTo').length > 1 || [...form.keys()].some(key => !['key', 'returnTo'].includes(key))) {
      throw new AppError(400, 'invalid_input', '올바른 로그인 요청이 필요합니다')
    }
    const session = await signInTestAccount(form.get('key'))
    const response = NextResponse.redirect(new URL(safeReturnTo(form.get('returnTo')), request.url), 303)
    response.cookies.set(ACCESS_TOKEN_COOKIE_NAME, session.accessToken, authCookieOptions(session.accessMaxAge))
    response.cookies.set(REFRESH_TOKEN_COOKIE_NAME, session.refreshToken, refreshCookieOptions(session.refreshMaxAge))
    response.headers.set('Cache-Control', 'private, no-store')
    return response
  } catch (error) { return errorResponse(error) }
}
