'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function RefreshSession() {
  const router = useRouter()

  useEffect(() => {
    let active = true

    void fetch('/api/auth/refresh', {
      cache: 'no-store',
      credentials: 'same-origin',
      method: 'POST',
    }).then((response) => {
      if (!active) return
      if (response.ok) router.refresh()
      else router.replace('/login')
    }).catch(() => {
      if (active) router.replace('/login')
    })

    return () => {
      active = false
    }
  }, [router])

  return (
    <main className="auth-page" aria-live="polite">
      <p className="auth-notice">세션을 확인하고 있어요</p>
    </main>
  )
}
