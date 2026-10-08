'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { clearAccessToken } from '../../../global/auth'
import { apiRequest } from '../../../global/util/apiClient'
import { ErrorNotice, Loading } from '../../home/ui'

export default function AuthCompleteClient({ returnTo }: { returnTo: string }) {
  const router = useRouter()
  const [error, setError] = useState<Error | null>(null)
  useEffect(() => {
    let active = true
    clearAccessToken()
    void apiRequest<{ purpose: 'app' | 'onboarding' }>('/api/auth/access-token', { method: 'POST' })
      .then(result => { if (active) router.replace(result.purpose === 'onboarding' ? `/onboarding?returnTo=${encodeURIComponent(returnTo)}` : returnTo) })
      .catch(error => { if (active) setError(error) })
    return () => { active = false }
  }, [returnTo, router])
  return <main className="app-shell stack"><Loading /><ErrorNotice error={error} retry={() => window.location.reload()} /></main>
}
