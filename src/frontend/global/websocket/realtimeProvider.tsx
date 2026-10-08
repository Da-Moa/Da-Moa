'use client'

import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { getAccessToken } from '../auth'
import { createWebsocketUtil, type WebsocketSubscribe } from './websocketUtil'

const RealtimeContext = createContext<WebsocketSubscribe | null>(null)
export const useWebsocketSubscribe = () => useContext(RealtimeContext)

export function RealtimeProvider({ accountId, reloadAccount, children }: {
  accountId: string; reloadAccount: () => Promise<{ id: string } | null>; children: ReactNode
}) {
  const accountReload = useRef(reloadAccount)
  accountReload.current = reloadAccount
  const websocket = useMemo(() => createWebsocketUtil({
    getToken: getAccessToken,
    beforeReconnect: async () => {
      const account = await accountReload.current()
      if (!account) return false
      if (account.id !== accountId) { window.location.reload(); return false }
      return true
    },
    onInvalidate: topics => { if (topics.includes('me')) void accountReload.current() },
  }), [accountId])
  useEffect(() => {
    void websocket.connect()
    return websocket.disconnect
  }, [websocket])
  return <RealtimeContext.Provider value={websocket.subscribe}>{children}</RealtimeContext.Provider>
}
