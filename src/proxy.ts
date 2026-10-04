import { NextResponse, type NextRequest } from 'next/server'
import { jwtGuard } from './Global/Auth/Backend'

export function proxy(request: NextRequest) {
  return jwtGuard(request) ?? NextResponse.next()
}

export const config = { matcher: '/api/:path*' }
