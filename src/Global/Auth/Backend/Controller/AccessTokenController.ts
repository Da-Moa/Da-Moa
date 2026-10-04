import 'server-only'
import { NextRequest, NextResponse } from 'next/server'
import { REFRESH_TOKEN_COOKIE_NAME, accessTokenForRefresh, readRefreshToken } from '../auth-util'
import { AppError, errorResponse } from '../../../../lib/errors'
import { sameOrigin } from '../../../../lib/http'

export async function getAccessTokenResponse(request: NextRequest) {
  try {
    if (!sameOrigin(request)) throw new AppError(403, 'forbidden', '허용되지 않은 요청입니다')
    const token = request.cookies.get(REFRESH_TOKEN_COOKIE_NAME)?.value
    const refresh = readRefreshToken(token)
    if (!token || !refresh) throw new AppError(401, 'unauthorized', '로그인이 필요합니다')
    return NextResponse.json({ data: accessTokenForRefresh(refresh) }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) { return errorResponse(error) }
}
