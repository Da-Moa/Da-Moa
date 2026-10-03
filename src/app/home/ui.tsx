'use client'

import { getAccessToken } from '../../Global/Auth/Frontend'

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ChevronDown, ChevronLeft, CircleUserRound, History, House, Menu, Search, Users, X } from 'lucide-react'
import { ApiError, apiRequest } from '../../lib/api-client'
import { AccountProvider } from '../../Domain/User/Frontend'
import type { Account } from '../../Domain/User/Shared'
import type { RoundStatus } from '../../lib/domain-types'
import { parseInvalidateEvent, resourceKeysForPath, type ResourceKey } from '../../lib/realtime'

type RealtimeSubscribe = (key: ResourceKey, listener: () => void) => () => void
const RealtimeContext = createContext<RealtimeSubscribe | null>(null)

export function useResource<T>(path: string | null) {
  const subscribe = useContext(RealtimeContext)
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(Boolean(path))
  const sequence = useRef(0)
  const reload = useCallback(async (fresh = true) => {
    if (!path) return null
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
    if (!path || !subscribe) return
    const listener = () => { void reload() }
    const cleanups = resourceKeysForPath(path).map(key => subscribe(key, listener))
    return () => cleanups.forEach(cleanup => cleanup())
  }, [path, reload, subscribe])
  return { data, setData, error, loading, reload }
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

export function ErrorNotice({ error, retry }: { error: Error | null; retry?: () => void }) {
  const [recovering, setRecovering] = useState(false)
  const [recoveryError, setRecoveryError] = useState<string | null>(null)
  if (!error) return null
  const stale = error instanceof ApiError && (error.code === 'stale_round' || error.code === 'bank_account_conflict')
  async function recover() {
    if (!(error instanceof ApiError) || !error.recover || recovering) return
    setRecovering(true); setRecoveryError(null)
    try { await error.recover(); window.location.reload() }
    catch (cause) { setRecoveryError(cause instanceof Error ? cause.message : '이전 요청 결과를 확인하지 못했어요.'); setRecovering(false) }
  }
  return <div className="notice notice-error" role="alert"><p>{error.message}</p>
    {stale && <p>{error instanceof ApiError && error.code === 'bank_account_conflict' ? '다른 계좌 변경이 먼저 저장되었어요. 최신 계좌를 불러와 확인한 뒤 다시 입력해 주세요.' : '다른 변경사항이 먼저 저장되었어요. 최신 내역을 확인한 뒤 다시 제출해 주세요. 입력한 내용은 유지돼요.'}</p>}
    {retry && <button className="text-button" type="button" onClick={retry}>{stale ? '최신 내역 불러오기' : '다시 시도'}</button>}
    {error instanceof ApiError && error.recover && <><p>이전 요청을 확인한 뒤 페이지를 새로 불러와요. 현재 수정한 입력은 저장되지 않아요.</p><button className="text-button" disabled={recovering} onClick={() => void recover()} type="button">{recovering ? '이전 요청 확인 중…' : '이전 요청 확인 후 새로고침'}</button>{recoveryError && <p>{recoveryError}</p>}</>}
  </div>
}

export function Loading({ text = '불러오는 중…' }: { text?: string }) { return <p className="loading-message" role="status">{text}</p> }
export const statusLabel: Record<RoundStatus, string> = { RECORDING: '기록 중', CONFIRMED: '확정 · 전송 전', LOCKED: '송금 대기중', COMPLETED: '정산 종료' }
export function StatusBadge({ status }: { status: RoundStatus }) { return <span className={`status-badge state-${status.toLowerCase()}`}>{statusLabel[status]}</span> }

export function ParticipantAvatar({ profileImageUrl }: { profileImageUrl: string | null }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  return <span aria-hidden="true" className="participant-avatar"><CircleUserRound size={24} />
    {profileImageUrl && failedUrl !== profileImageUrl && <img alt="" decoding="async" loading="lazy" onError={() => setFailedUrl(profileImageUrl)} referrerPolicy="no-referrer" src={profileImageUrl} />}
  </span>
}

export function CopyLink({ path, label = '링크 복사', hideButton = false }: { path: string; label?: string; hideButton?: boolean }) {
  const [message, setMessage] = useState('')
  const [url, setUrl] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { setUrl(new URL(path, window.location.origin).href) }, [path])
  async function copy() {
    try { await navigator.clipboard.writeText(url); setMessage('링크를 복사했어요. 원하는 대화방에 붙여 넣어 주세요.') }
    catch { input.current?.select(); setMessage('자동 복사를 사용할 수 없어요. 아래 링크를 선택해 직접 복사해 주세요.') }
  }
  return <div className="copy-link">{!hideButton && <button className="primary-button" type="button" disabled={!url} onClick={() => void copy()}>{label}</button>}
    <label className="field"><span>공유 링크</span><input aria-label="공유 링크" onFocus={event => event.target.select()} readOnly ref={input} value={url} /></label>
    {message && <p className="help-text" role="status">{message}</p>}
  </div>
}

export function SheetSelect({ label, name, title, value, onChange, options, disabled, sheetClassName, showSelectedIcon, searchPlaceholder }: {
  label: string; name: string; title: string; value: string; onChange: (value: string) => void;
  options: readonly { value: string; label: string; icon?: ReactNode; searchText?: string }[]; disabled?: boolean; sheetClassName?: string; showSelectedIcon?: boolean; searchPlaceholder?: string;
}) {
  const id = useId()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const closing = useRef(false)
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [opened, setOpened] = useState(false)
  const [scrolling, setScrolling] = useState(false)
  const [scrollbarHovered, setScrollbarHovered] = useState(false)
  const [search, setSearch] = useState('')
  useEffect(() => () => clearTimeout(scrollTimer.current), [])
  function showScrollbar() {
    setScrolling(true)
    clearTimeout(scrollTimer.current)
    scrollTimer.current = setTimeout(() => setScrolling(false), 800)
  }
  const filtered = options.filter(option => `${option.label} ${option.searchText ?? ''}`.toLocaleLowerCase('ko-KR').includes(search.trim().toLocaleLowerCase('ko-KR')))
  const selected = options.find(option => option.value === value)
  function open() {
    if (disabled || closing.current) return
    clearTimeout(scrollTimer.current)
    setScrolling(false)
    setScrollbarHovered(false)
    setSearch('')
    dialogRef.current?.showModal()
    setOpened(true)
    dialogRef.current?.querySelector<HTMLButtonElement>(`[data-value="${value || options[0].value}"]`)?.focus()
  }
  async function close() {
    const dialog = dialogRef.current
    if (!dialog?.open || closing.current) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { dialog.close(); return }
    closing.current = true
    const animation = dialog.animate([{ transform: getComputedStyle(dialog).transform }, { transform: 'translateY(100%)' }], { duration: 200, easing: 'ease-in', fill: 'forwards' })
    try { await animation.finished } catch { /* A cancelled animation must still close the dialog. */ }
    if (dialog.isConnected) dialog.close()
    animation.cancel()
    closing.current = false
  }
  function choose(next: string) {
    if (closing.current) return
    onChange(next)
    void close()
  }
  return <>
    <div className={`bank-select${value ? ' bank-select-filled' : ''}`}>
      <span id={`${id}-label`}>{label}</span>
      <button aria-controls={`${id}-sheet`} aria-expanded={opened} aria-haspopup="dialog" aria-labelledby={`${id}-label ${id}-value`} className="bank-select-trigger" disabled={disabled} onClick={open} ref={trigger} type="button"><span className="bank-select-value" id={`${id}-value`}>{showSelectedIcon && selected?.icon}{selected?.label}</span><ChevronDown aria-hidden="true" size={20} /></button>
      <select aria-hidden="true" autoComplete="off" className="bank-select-native" disabled={disabled} name={name} onChange={event => choose(event.currentTarget.value)} onInvalid={event => { event.preventDefault(); open() }} required tabIndex={-1} value={value}>{!value && <option value="" disabled>{title}</option>}{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
    </div>
    <dialog aria-labelledby={`${id}-title`} className={`bank-sheet ${sheetClassName ?? ''}`} id={`${id}-sheet`} onCancel={event => { event.preventDefault(); void close() }} onClick={event => { if (event.target === event.currentTarget) void close() }} onClose={() => { setOpened(false); trigger.current?.focus() }} ref={dialogRef}>
      <div className="bank-sheet-content"><div className="bank-sheet-handle" aria-hidden="true" /><header className="bank-sheet-header"><h2 id={`${id}-title`}>{title}</h2><button aria-label={`${label} 닫기`} className="icon-button" onClick={() => void close()} type="button"><X aria-hidden="true" size={20} /></button></header>
        {searchPlaceholder && <div className="round-search-bar currency-search"><Search aria-hidden="true" size={21} /><input aria-label={searchPlaceholder} autoComplete="off" maxLength={100} onChange={event => setSearch(event.target.value)} placeholder={searchPlaceholder} type="search" value={search} /></div>}
        <div aria-label={`${label} 목록`} className="bank-grid" data-scrolling={scrolling || undefined} data-scrollbar-hovered={scrollbarHovered || undefined} onPointerMove={event => { const list = event.currentTarget; setScrollbarHovered(event.pointerType === 'mouse' && event.clientX >= list.getBoundingClientRect().left + list.clientLeft + list.clientWidth) }} onPointerLeave={() => setScrollbarHovered(false)} onScroll={showScrollbar} role="group">{filtered.map(option => <button aria-pressed={value === option.value} className="bank-tile" data-value={option.value} key={option.value} onClick={() => choose(option.value)} type="button">{option.icon}<span>{option.label}</span></button>)}</div>
        {filtered.length === 0 && <p className="help-text" role="status">검색 결과가 없어요.</p>}
      </div>
    </dialog>
  </>
}

function RealtimeProvider({ accountId, reloadAccount, children }: { accountId: string; reloadAccount: () => Promise<Account | null>; children: ReactNode }) {
  const listeners = useRef(new Map<ResourceKey, Set<() => void>>())
  const accountReload = useRef(reloadAccount)
  accountReload.current = reloadAccount
  const subscribe = useCallback<RealtimeSubscribe>((key, listener) => {
    const current = listeners.current.get(key) ?? new Set()
    current.add(listener); listeners.current.set(key, current)
    return () => { current.delete(listener); if (!current.size) listeners.current.delete(key) }
  }, [])
  useEffect(() => {
    let socket: WebSocket | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let reconnect: ReturnType<typeof setTimeout> | null = null
    let attempts = 0
    let disposed = false
    const pending = new Map<ResourceKey, Set<() => void>>()
    const queue = (keys: ResourceKey[]) => {
      if (disposed) return
      keys.forEach(key => {
        const callbacks = pending.get(key) ?? new Set<() => void>()
        listeners.current.get(key)?.forEach(listener => callbacks.add(listener))
        pending.set(key, callbacks)
      })
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        const callbacks = new Set<() => void>()
        for (const [key, queued] of pending) {
          if (key === 'me') void accountReload.current()
          queued.forEach(listener => { if (listeners.current.get(key)?.has(listener)) callbacks.add(listener) })
        }
        pending.clear()
        callbacks.forEach(listener => listener())
      }, 120)
    }
    const retry = (event?: CloseEvent) => {
      if (disposed) return
      reconnect = setTimeout(() => { void connect(true) }, event?.code === 4001 ? 0 : Math.min(30000, 1000 * 2 ** Math.min(attempts++, 5)))
    }
    const connect = async (refresh = false) => {
      try {
        if (refresh) {
          const account = await accountReload.current()
          if (disposed) return
          if (!account) { retry(); return }
          if (account.id !== accountId) { window.location.reload(); return }
        }
        if (disposed) return
        const token = getAccessToken()
        if (!token) { retry(); return }
        socket = new WebSocket(`${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/realtime`, ['da-moa', token])
        socket.onopen = () => { attempts = 0; if (refresh) queue([...listeners.current.keys()]) }
        socket.onmessage = message => { const event = parseInvalidateEvent(message.data); if (event) queue(event.keys) }
        socket.onclose = retry
        socket.onerror = () => socket?.close()
      } catch { retry() }
    }
    void connect()
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      if (reconnect) clearTimeout(reconnect)
      if (socket) { socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null; socket.close() }
    }
  }, [accountId])
  return <RealtimeContext.Provider value={subscribe}>{children}</RealtimeContext.Provider>
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/home'
  const hasBackButton = pathname === '/home/account' || pathname.startsWith('/home/groups/') || pathname.startsWith('/home/rounds/') || pathname.startsWith('/settlements/')
  const tabTitle = pathname === '/home/groups' ? '내 모임' : pathname === '/home/history' ? '정산 기록' : pathname === '/home/all' ? '전체' : null
  const topbarContent = pathname === '/home' ? <Link className="brand" href="/home" aria-label="다모아 홈"><img alt="다모아" height="38" src="/logo/da-moa-trans.png" width="46" /></Link> : tabTitle ? <h1 className="topbar-title">{tabTitle}</h1> : pathname.startsWith('/invites/') ? <span className="topbar-title">모임 초대</span> : null
  const me = useResource<Account>('/api/me')
  const previousPath = useRef(pathname)
  const [checkedPath, setCheckedPath] = useState(pathname)
  const verifyPage = useCallback(async () => {
    const account = await me.reload()
    if (account && previousPath.current === pathname) setCheckedPath(pathname)
    return account
  }, [pathname, me.reload])
  useEffect(() => {
    if (previousPath.current === pathname) return
    previousPath.current = pathname
    void verifyPage()
  }, [pathname, verifyPage])
  const account = me.data
  useEffect(() => {
    if (account && (account.purpose === 'onboarding' || !account.onboardingCompletedAt || account.deletedAt)) window.location.replace(`/onboarding?returnTo=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`)
  }, [account])
  if (!account || account.purpose !== 'app' || !account.onboardingCompletedAt || account.deletedAt) return <main className="app-shell">{!hasBackButton && <header className="topbar">{topbarContent}</header>}<Loading text="로그인 상태를 확인하고 있어요…" /><ErrorNotice error={me.error} retry={() => void me.reload()} /></main>
  const links = [
    { href: '/home', label: '홈', icon: House, active: pathname === '/home' },
    { href: '/home/groups', label: '모임', icon: Users, active: pathname.startsWith('/home/groups') || pathname.startsWith('/home/rounds') },
    { href: '/home/history', label: '정산 기록', icon: History, active: pathname === '/home/history' },
    { href: '/home/all', label: '전체', icon: Menu, active: pathname === '/home/all' || pathname === '/home/account' },
  ]
  return <RealtimeProvider accountId={account.id} reloadAccount={me.reload}><AccountProvider account={account} reloadAccount={me.reload}><main className="app-shell">
    <header className="topbar">{topbarContent}</header>
    {checkedPath === pathname ? children : <><Loading text="로그인 상태를 확인하고 있어요…" /><ErrorNotice error={me.error} retry={() => void verifyPage()} /></>}
    <nav aria-label="주 메뉴" className="bottom-nav">{links.map(({ href, label, icon: Icon, active }) => <Link key={href} href={href} aria-current={active ? 'page' : undefined}><Icon size={22} /><span>{label}</span></Link>)}</nav>
  </main></AccountProvider></RealtimeProvider>
}
