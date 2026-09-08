'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

export default function RefreshSession() {
  const router = useRouter()
  const [attempt, setAttempt] = useState(0)
  const [refreshFailed, setRefreshFailed] = useState(false)

  useEffect(() => {
    let active = true
    setRefreshFailed(false)

    void fetch('/api/auth/refresh', {
      cache: 'no-store',
      credentials: 'same-origin',
      method: 'POST',
    }).then((response) => {
      if (!active) return
      if (response.ok) {
        router.refresh()
        return
      }
      if (response.status === 401) {
        router.replace(`/login?returnTo=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`)
        return
      }
      setRefreshFailed(true)
    }).catch(() => {
      if (active) setRefreshFailed(true)
    })

    return () => {
      active = false
    }
  }, [attempt, router])

  return (
    <main className="auth-page" aria-live="polite">
      {refreshFailed ? (
        <p className="auth-setup" role="alert">
          세션을 갱신하지 못했어요. <button className="auth-retry" onClick={() => setAttempt((value) => value + 1)} type="button">다시 시도</button>
        </p>
      ) : <p className="auth-notice">세션을 확인하고 있어요</p>}
    </main>
  )
}
