import { cookies } from 'next/headers'
import { ACCESS_TOKEN_COOKIE_NAME, currentTimestamp, readAccessToken } from '../../lib/auth'
import { getUserAccount, isActiveSession } from '../../lib/auth-store'
import HomeClient from './home-client'
import RefreshSession from './refresh-session'

export type HomeTab = 'home' | 'groups' | 'history' | 'all'

export async function renderAuthenticatedHome(tab: HomeTab) {
  const cookieStore = await cookies()
  const access = readAccessToken(cookieStore.get(ACCESS_TOKEN_COOKIE_NAME)?.value)
  if (access) {
    try {
      if (await isActiveSession(access.userId, access.sessionId, currentTimestamp())) {
        return <HomeClient account={await getUserAccount(access.userId)} tab={tab} />
      }
    } catch {
      // Fail closed: the refresh route will clear the cookies if Neon is unavailable.
    }
  }

  return <RefreshSession />
}
