import { safeReturnTo } from '../../../shared/authUrls'
import AuthCompleteClient from '../../../frontend/page/auth/complete/authCompleteClient'

export default async function AuthCompletePage({ searchParams }: { searchParams: Promise<{ returnTo?: string }> }) {
  return <AuthCompleteClient returnTo={safeReturnTo((await searchParams).returnTo)} />
}
