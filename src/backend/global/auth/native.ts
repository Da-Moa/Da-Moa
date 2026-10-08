// Public native Node entrypoint: no Next.js or React runtime dependencies.
import { readAccessToken } from './authUtil.ts'
import { getRealtimeUserState } from '../../domain/user/native.ts'
export * from './authUtil.ts'
export { apiJwtPolicy, readApiJwt } from './apiJwtUtil.ts'

export async function authenticateWebsocketToken(token: string | null) {
  const access = readAccessToken(token ?? undefined)
  if (!access) return { status: 401 }
  if ((access.purpose ?? 'app') !== 'app') return { status: 403 }
  const account = await getRealtimeUserState(access.userId)
  if (!account || account.deleted_at !== null) return { status: 401 }
  return account.onboarding_completed_at !== null ? { status: 200, id: account.id } : { status: 403 }
}
