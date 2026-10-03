import 'server-only'
import { after, NextRequest, NextResponse } from 'next/server'
import { ACCESS_TOKEN_COOKIE_NAME, REFRESH_TOKEN_COOKIE_NAME, RETURN_TO_COOKIE_NAME, OIDC_COOKIE_NAMES, authCookieOptions, refreshCookieOptions, readRequestAccessToken, readReturnToCookie } from '../../../../Global/Auth/Backend'
import { AppError, errorResponse, readJsonBody, sameOrigin } from '../../../../Global/Util/Backend'
import { publishBankInvalidation, publishDepartureInvalidation } from '../../../../Global/Websocket/Backend'
import { completeOnboarding, getMe, updateBankAccount, withdrawAccount } from '../Service/UserService'

export async function getMeResponse(request: NextRequest) {
  try {
    const data = await getMe(readRequestAccessToken(request))
    return NextResponse.json({ data }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function getOnboardingResponse(request: NextRequest) {
  try {
    if (!sameOrigin(request)) throw new AppError(403, 'forbidden', '허용되지 않은 요청입니다')
    const input = await readJsonBody(request, 16384)
    const access = readRequestAccessToken(request)
    const returnTo = readReturnToCookie(request.cookies.get(RETURN_TO_COOKIE_NAME)?.value)
    const session = await completeOnboarding(access, input)
    after(() => publishBankInvalidation(session.userId))
    const response = NextResponse.json({ data: { id: session.userId, returnTo, accessToken: session.accessToken } }, { headers: { 'Cache-Control': 'private, no-store' } })
    response.cookies.set(ACCESS_TOKEN_COOKIE_NAME, '', authCookieOptions(0))
    response.cookies.set(REFRESH_TOKEN_COOKIE_NAME, session.refreshToken, refreshCookieOptions(session.refreshMaxAge))
    response.cookies.set(RETURN_TO_COOKIE_NAME, '', authCookieOptions(0))
    return response
  } catch (error) {
    return errorResponse(error)
  }
}

export async function getBankAccountResponse(request: NextRequest) {
  try {
    if (!sameOrigin(request)) throw new AppError(403, 'forbidden', '허용되지 않은 요청입니다')
    const input = await readJsonBody(request, 16384)
    const result = await updateBankAccount(readRequestAccessToken(request), request.headers.get('Idempotency-Key') ?? '', input)
    after(() => publishBankInvalidation(result.id))
    return NextResponse.json({ data: result }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function getWithdrawalResponse(request: NextRequest) {
  try {
    if (!sameOrigin(request)) throw new AppError(403, 'forbidden', '허용되지 않은 요청입니다')
    const access = readRequestAccessToken(request)
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
