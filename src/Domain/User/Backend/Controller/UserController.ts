import 'server-only'
import { after, NextRequest, NextResponse } from 'next/server'
import { RETURN_TO_COOKIE_NAME, setAuthCookies, clearAuthCookies, clearReturnToCookie, readRequestAccessToken, readReturnToCookie } from '../../../../Global/Auth/Backend'
import { AppError, errorResponse, readJsonBody, sameOrigin } from '../../../../Global/Util/Backend'
import { publishBankInvalidation } from './UserInvalidation'
import { publishDepartureInvalidation } from '../../../Group/Backend'
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
    setAuthCookies(response, session)
    clearReturnToCookie(response)
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
    clearAuthCookies(response, { returnTo: true, oidc: true })
    return response
  } catch (error) {
    return errorResponse(error)
  }
}
