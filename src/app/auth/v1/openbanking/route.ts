import { NextRequest, NextResponse } from 'next/server'
import { ACCESS_TOKEN_COOKIE_NAME, readAccessToken } from '../../../../lib/auth'
import { AppError } from '../../../../lib/errors'
import { getAccount } from '../../../../lib/authorization'
import { completeOpenBanking } from '../../../../lib/openbanking-store'
import { OPENBANKING_CALLBACK_COOKIE, openBankingCallbackCookieOptions, readOpenBankingCallbackCookie } from '../../../../lib/openbanking-callback'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  let destination: URL
  let access = readAccessToken(request.cookies.get(ACCESS_TOKEN_COOKIE_NAME)?.value)
  let matchedCallbackCookie = false
  try {
    const params = request.nextUrl.searchParams
    if (['state', 'code', 'error'].some(key => params.getAll(key).length > 1)) throw new AppError(400, 'invalid_input', '인증 응답을 확인해 주세요')
    const state = params.get('state') ?? ''
    const callbackAccess = readOpenBankingCallbackCookie(request.cookies.get(OPENBANKING_CALLBACK_COOKIE)?.value, state)
    matchedCallbackCookie = callbackAccess !== null
    access ??= callbackAccess
    const result = await completeOpenBanking(access, state, {
      code: params.get('code') ?? undefined,
      error: params.get('error') ?? undefined,
    })
    destination = new URL(result.returnTo, request.nextUrl.origin)
    if (result.error) destination.searchParams.set('openbanking_error', result.error)
  } catch (error) {
    // No code, token, provider message or untrusted return path is reflected into the redirect.
    const account = await getAccount(access, true).catch(() => null)
    destination = new URL(account?.purpose === 'app' ? '/home?account=1' : '/onboarding', request.nextUrl.origin)
    destination.searchParams.set('verify', '1')
    destination.searchParams.set('openbanking_error', error instanceof AppError ? error.code : 'openbanking_unavailable')
  }
  const response = NextResponse.redirect(destination, { status: 303, headers: { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' } })
  if (matchedCallbackCookie) response.cookies.set(OPENBANKING_CALLBACK_COOKIE, '', openBankingCallbackCookieOptions(0))
  return response
}
