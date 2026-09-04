import { cookies } from 'next/headers'
import { ACCESS_TOKEN_COOKIE_NAME, readAccessToken } from '../../lib/auth'
import { getUserAccount } from '../../lib/auth-store'
import HomeClient from './home-client'
import RefreshSession from './refresh-session'

export type HomeTab = 'home' | 'groups' | 'history' | 'all'

export async function renderAuthenticatedHome(tab: HomeTab) {
  const cookieStore = await cookies()
  const access = readAccessToken(cookieStore.get(ACCESS_TOKEN_COOKIE_NAME)?.value)
  if (access) {
    try {
      const account = await getUserAccount(access.userId)
      if (account) return <HomeClient account={account} tab={tab} />
    } catch {
      // Keep valid cookies so the refresh screen can offer a retry when Neon is unavailable.
    }
  }

  return <RefreshSession />
}
