import { safeReturnTo } from '../../../lib/auth'
import AuthCompleteClient from './auth-complete-client'

export default async function AuthCompletePage({ searchParams }: { searchParams: Promise<{ returnTo?: string }> }) {
  return <AuthCompleteClient returnTo={safeReturnTo((await searchParams).returnTo)} />
}
