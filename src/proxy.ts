import { NextResponse } from 'next/server'

// API authentication is enforced by the Nest guard in the custom server.
export function proxy() { return NextResponse.next() }
export const config = { matcher: '/api/docs' }
