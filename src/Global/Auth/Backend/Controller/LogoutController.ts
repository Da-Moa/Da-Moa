import 'server-only'
import { clearAuthCookies } from './AuthCookies'
import { NextRequest, NextResponse } from 'next/server'
import { sameOrigin } from '../../../../lib/http'

export async function getLogoutResponse(request: NextRequest) {
  if (!sameOrigin(request)) {
    const response = NextResponse.json({ error: 'forbidden' }, { status: 403 })
    response.headers.set('Cache-Control', 'private, no-store')
    return response
  }

  const response = NextResponse.json({ ok: true })
  clearAuthCookies(response, { returnTo: true })
  response.headers.set('Cache-Control', 'private, no-store')
  return response
}
