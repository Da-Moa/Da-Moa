'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, apiRequest } from '../../../lib/api-client'
import { resourceKeysForPath, useWebsocketSubscribe } from '../../Websocket/Frontend'

export function useResource<T>(path: string | null, { refreshOnResume = false }: { refreshOnResume?: boolean } = {}) {
  const subscribe = useWebsocketSubscribe()
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(Boolean(path))
  const sequence = useRef(0)
  const suspended = useRef(false)
  const reload = useCallback(async (fresh = true) => {
    if (!path || suspended.current) return null
    const request = ++sequence.current
    setLoading(true)
    setError(null)
    try {
      const value = await apiRequest<T>(path, { fresh })
      if (request === sequence.current) setData(value)
      return value
    } catch (cause) {
      if (request === sequence.current) {
        if (cause instanceof ApiError && cause.code === 'not_found') setData(null)
        setError(cause instanceof Error ? cause : new Error('자료를 불러오지 못했어요.'))
      }
      return null
    } finally { if (request === sequence.current) setLoading(false) }
  }, [path])
  useEffect(() => { setData(null); void reload(false); return () => { sequence.current++ } }, [reload])
  useEffect(() => {
    if (!path) return
    let timer: ReturnType<typeof setTimeout> | undefined
    // WebSocket invalidations are already batched by the connection utility.
    // A delivered invalidation also satisfies a pending page-resume refresh.
    const listener = () => {
      clearTimeout(timer)
      if (!suspended.current) void reload()
    }
    const resumeListener = () => {
      if (document.visibilityState !== 'visible' || suspended.current) return
      clearTimeout(timer)
      timer = setTimeout(listener, 120)
    }
    const cleanups = subscribe ? resourceKeysForPath(path).map(key => subscribe(key, listener)) : []
    if (refreshOnResume) {
      window.addEventListener('focus', resumeListener)
      window.addEventListener('pageshow', resumeListener)
      document.addEventListener('visibilitychange', resumeListener)
    }
    return () => {
      clearTimeout(timer)
      cleanups.forEach(cleanup => cleanup())
      window.removeEventListener('focus', resumeListener)
      window.removeEventListener('pageshow', resumeListener)
      document.removeEventListener('visibilitychange', resumeListener)
    }
  }, [path, reload, subscribe, refreshOnResume])
  const suspend = useCallback(() => { suspended.current = true; sequence.current++ }, [])
  const resume = useCallback(() => { suspended.current = false; return reload() }, [reload])
  return { data, setData, error, loading, reload, suspend, resume }
}

export function useAction() {
  const inFlight = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  async function run<T>(operation: () => Promise<T>): Promise<T | undefined> {
    if (inFlight.current) return undefined
    inFlight.current = true; setBusy(true); setError(null)
    try { return await operation() }
    catch (cause) { setError(cause instanceof Error ? cause : new Error('요청에 실패했어요.')) }
    finally { inFlight.current = false; setBusy(false) }
  }
  return { busy, error, setError, run }
}
