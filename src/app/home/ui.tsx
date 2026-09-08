'use client'

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { CircleUserRound, History, House, Menu, Users, X } from 'lucide-react'
import { ApiError, apiRequest } from '../../lib/api-client'
import type { RoundStatus } from '../../lib/domain-types'
import { parseInvalidateEvent, realtimeUserChannel, resourceKeysForPath, type ResourceKey } from '../../lib/realtime'

type RealtimeSubscribe = (key: ResourceKey, listener: () => void) => () => void
const RealtimeContext = createContext<RealtimeSubscribe | null>(null)

export type Account = {
  id: string; displayName: string | null; email: string | null; profileImageUrl: string | null;
  onboardingCompletedAt: number | null; deletedAt: number | null; purpose: 'app' | 'onboarding';
  bankAccount: { bankName: string; accountNumber: string; accountHolder: string } | null
}

export function useResource<T>(path: string | null) {
  const subscribe = useContext(RealtimeContext)
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(Boolean(path))
  const sequence = useRef(0)
  const reload = useCallback(async () => {
    if (!path) return null
    const request = ++sequence.current
    setLoading(true)
    setError(null)
    try {
      const value = await apiRequest<T>(path)
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
  useEffect(() => { setData(null); void reload(); return () => { sequence.current++ } }, [reload])
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
  const stale = error instanceof ApiError && error.code === 'stale_round'
  async function recover() {
    if (!(error instanceof ApiError) || !error.recover || recovering) return
    setRecovering(true); setRecoveryError(null)
    try { await error.recover(); window.location.reload() }
    catch (cause) { setRecoveryError(cause instanceof Error ? cause.message : '이전 요청 결과를 확인하지 못했어요.'); setRecovering(false) }
  }
  return <div className="notice notice-error" role="alert"><p>{error.message}</p>
    {stale && <p>다른 변경사항이 먼저 저장되었어요. 최신 내역을 확인한 뒤 다시 제출해 주세요. 입력한 내용은 유지돼요.</p>}
    {retry && <button className="text-button" type="button" onClick={retry}>{stale ? '최신 내역 불러오기' : '다시 시도'}</button>}
    {error instanceof ApiError && error.recover && <><p>이전 요청을 확인한 뒤 페이지를 새로 불러와요. 현재 수정한 입력은 저장되지 않아요.</p><button className="text-button" disabled={recovering} onClick={() => void recover()} type="button">{recovering ? '이전 요청 확인 중…' : '이전 요청 확인 후 새로고침'}</button>{recoveryError && <p>{recoveryError}</p>}</>}
  </div>
}

export function Loading({ text = '불러오는 중…' }: { text?: string }) { return <p className="loading-message" role="status">{text}</p> }
export const statusLabel: Record<RoundStatus, string> = { RECORDING: '기록 중', CONFIRMED: '확정 · 전송 전', LOCKED: '전송 · 기록 잠김', COMPLETED: '정산 종료' }
export function StatusBadge({ status }: { status: RoundStatus }) { return <span className={`status-badge state-${status.toLowerCase()}`}>{statusLabel[status]}</span> }

export function CopyLink({ path, label = '링크 복사' }: { path: string; label?: string }) {
  const [message, setMessage] = useState('')
  const [url, setUrl] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { setUrl(new URL(path, window.location.origin).href) }, [path])
  async function copy() {
    try { await navigator.clipboard.writeText(url); setMessage('링크를 복사했어요. 원하는 대화방에 붙여 넣어 주세요.') }
    catch { input.current?.select(); setMessage('자동 복사를 사용할 수 없어요. 아래 링크를 선택해 직접 복사해 주세요.') }
  }
  return <div className="copy-link"><button className="primary-button" type="button" disabled={!url} onClick={() => void copy()}>{label}</button>
    <label className="field"><span>공유 링크</span><input aria-label="공유 링크" onFocus={event => event.target.select()} readOnly ref={input} value={url} /></label>
    <p className="help-text" role="status">{message || (path.startsWith('/invites/') ? '링크를 받은 사람이 로그인 후 초대를 수락하면 모임에 참여해요.' : '링크를 연 사람은 로그인 후 본인의 내역만 볼 수 있어요.')}</p>
  </div>
}

const AccountContext = createContext<{ account: Account; reloadAccount: () => Promise<Account | null> } | null>(null)
export function useAccount() {
  const value = useContext(AccountContext)
  if (!value) throw new Error('Account provider required')
  return value
}

export function BankFields({ initial }: { initial: Account['bankAccount'] }) {
  const id = useId()
  return <>
    <label className="field" htmlFor={`${id}-bank`}><span>은행</span><input autoComplete="organization" defaultValue={initial?.bankName ?? ''} id={`${id}-bank`} maxLength={100} name="bankName" required /></label>
    <label className="field" htmlFor={`${id}-number`}><span>계좌번호</span><input autoComplete="off" defaultValue={initial?.accountNumber ?? ''} id={`${id}-number`} inputMode="numeric" maxLength={64} name="accountNumber" pattern="[0-9 -]+" required /></label>
    <label className="field" htmlFor={`${id}-holder`}><span>예금주</span><input autoComplete="name" defaultValue={initial?.accountHolder ?? ''} id={`${id}-holder`} maxLength={100} name="accountHolder" required /></label>
  </>
}
export function bankValues(form: HTMLFormElement) {
  const values = new FormData(form)
  return { bankName: String(values.get('bankName') ?? ''), accountNumber: String(values.get('accountNumber') ?? ''), accountHolder: String(values.get('accountHolder') ?? '') }
}

function RealtimeProvider({ accountId, enabled, reloadAccount, children }: { accountId: string; enabled: boolean; reloadAccount: () => Promise<Account | null>; children: ReactNode }) {
  const listeners = useRef(new Map<ResourceKey, Set<() => void>>())
  const accountReload = useRef(reloadAccount)
  accountReload.current = reloadAccount
  const subscribe = useCallback<RealtimeSubscribe>((key, listener) => {
    const current = listeners.current.get(key) ?? new Set()
    current.add(listener); listeners.current.set(key, current)
    return () => { current.delete(listener); if (!current.size) listeners.current.delete(key) }
  }, [])
  useEffect(() => {
    if (!enabled) return
    let client: import('ably/modular').BaseRealtime | null = null
    let channel: import('ably').RealtimeChannel | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let disposed = false
    const pending = new Set<ResourceKey>()
    const queue = (keys: ResourceKey[]) => {
      keys.forEach(key => pending.add(key))
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        for (const key of pending) {
          if (key === 'me') void accountReload.current()
          listeners.current.get(key)?.forEach(listener => listener())
        }
        pending.clear()
      }, 120)
    }
    void import('ably/modular').then(async ({ BaseRealtime, FetchRequest, WebSocketTransport }) => {
      if (disposed) return
      client = new BaseRealtime({
        authCallback: (_params, callback) => { void apiRequest<import('ably').TokenRequest>('/api/realtime/auth').then(token => callback(null, token)).catch(error => callback(error instanceof Error ? error.message : '실시간 인증에 실패했습니다', null)) },
        echoMessages: false, plugins: { FetchRequest, WebSocketTransport },
      })
      channel = client.channels.get(realtimeUserChannel(accountId))
      const onAttached = () => queue(['me', ...listeners.current.keys()])
      const onMessage = (message: import('ably').InboundMessage) => { const event = parseInvalidateEvent(message.data); if (event) queue(event.keys) }
      channel.on('attached', onAttached)
      try { await channel.subscribe('invalidate', onMessage) } catch { if (!disposed) console.error('Realtime subscription failed') }
      if (disposed) { channel.unsubscribe('invalidate', onMessage); channel.off('attached', onAttached); client.close() }
    }).catch(() => { if (!disposed) console.error('Realtime client failed to load') })
    return () => { disposed = true; if (timer) clearTimeout(timer); channel?.unsubscribe(); channel?.off(); client?.close() }
  }, [accountId, enabled])
  return <RealtimeContext.Provider value={subscribe}>{children}</RealtimeContext.Provider>
}

export function AccountPanel() {
  const { account, reloadAccount } = useAccount()
  const action = useAction()
  const [saved, setSaved] = useState(false)
  const [blockedRounds, setBlockedRounds] = useState<{ id: string; name: string; groupName?: string }[]>([])
  async function save(form: HTMLFormElement) {
    setSaved(false)
    const result = await action.run(() => apiRequest('/api/me/bank-account', { method: 'PUT', body: bankValues(form) }))
    if (result) { setSaved(true); await reloadAccount() }
  }
  async function logout() {
    const result = await action.run(() => apiRequest('/api/auth/logout', { method: 'POST' }))
    if (result) window.location.assign('/login')
  }
  async function withdraw() {
    if (!window.confirm('진행 중인 회차가 있으면 탈퇴할 수 없어요. 탈퇴 후에도 과거 정산과 계좌는 보존되며, 재가입해도 기존 모임으로 자동 복귀하지 않아요. 생성한 모임의 관리 권한도 복구되지 않아요. 탈퇴할까요?')) return
    setBlockedRounds([])
    await action.run(async () => {
      try { await apiRequest('/api/auth/withdraw', { method: 'POST' }); window.location.assign('/') }
      catch (error) {
        if (error instanceof ApiError && error.code === 'unfinished_rounds') {
          const details = error.details as { rounds?: { id: string; name: string; groupName?: string }[] } | undefined
          setBlockedRounds(details?.rounds ?? [])
        }
        throw error
      }
    })
  }
  return <div className="stack">
    <div className="account-provider"><span className="account-avatar">{account.profileImageUrl ? <img alt="" height={56} width={56} referrerPolicy="no-referrer" src={account.profileImageUrl} /> : <CircleUserRound size={28} />}</span><div><strong>{account.displayName ?? '카카오 사용자'}</strong><p className="help-text">{account.email}</p></div></div>
    <form className="stack" onSubmit={event => { event.preventDefault(); void save(event.currentTarget) }}><h3>내 계좌</h3><BankFields initial={account.bankAccount} />
      <p className="help-text">받을 돈이 있는 정산에는 최신 계좌가 표시돼요. 계좌 실명 확인과 실제 송금은 제공하지 않아요.</p>
      <button className="primary-button" disabled={action.busy} type="submit">{action.busy ? '처리 중…' : '계좌 저장'}</button>
      {saved && <p className="notice" role="status">계좌를 저장했어요.</p>}
    </form><ErrorNotice error={action.error} />
    {blockedRounds.length > 0 && <div className="notice"><strong>먼저 종료해야 하는 회차</strong><ul>{blockedRounds.map(round => <li key={round.id}><Link href={`/home/rounds/${round.id}`}>{round.groupName ? `${round.groupName} · ` : ''}{round.name}</Link></li>)}</ul></div>}
    <button className="secondary-button" disabled={action.busy} onClick={() => void logout()} type="button">로그아웃</button>
    <button className="text-button danger-text" disabled={action.busy} onClick={() => void withdraw()} type="button">회원 탈퇴</button>
  </div>
}

export function AppShell({ children, realtimeEnabled }: { children: ReactNode; realtimeEnabled: boolean }) {
  const pathname = usePathname() ?? '/home'
  const me = useResource<Account>('/api/me')
  const dialog = useRef<HTMLDialogElement>(null)
  const account = me.data
  useEffect(() => {
    if (account && (account.purpose === 'onboarding' || !account.onboardingCompletedAt || account.deletedAt)) window.location.replace(`/onboarding?returnTo=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`)
  }, [account])
  if (!account || account.purpose !== 'app' || !account.onboardingCompletedAt || account.deletedAt) return <main className="app-shell"><Link className="brand" href="/">다모아</Link><Loading text="로그인 상태를 확인하고 있어요…" /><ErrorNotice error={me.error} retry={() => void me.reload()} /></main>
  const links = [
    { href: '/home', label: '홈', icon: House, active: pathname === '/home' },
    { href: '/home/groups', label: '모임', icon: Users, active: pathname.startsWith('/home/groups') || pathname.startsWith('/home/rounds') },
    { href: '/home/history', label: '정산 기록', icon: History, active: pathname === '/home/history' },
    { href: '/home/all', label: '전체', icon: Menu, active: pathname === '/home/all' },
  ]
  return <RealtimeProvider accountId={account.id} enabled={realtimeEnabled} reloadAccount={me.reload}><AccountContext.Provider value={{ account, reloadAccount: me.reload }}><main className="app-shell">
    <header className="topbar"><Link className="brand" href="/home" aria-label="다모아 홈"><img alt="다모아" height="38" src="/logo/da-moa-trans.png" width="46" /></Link><button aria-label="내 계좌와 계정" aria-haspopup="dialog" className="icon-button" onClick={() => dialog.current?.showModal()} type="button"><CircleUserRound size={24} /></button></header>
    <dialog className="account-dialog" aria-labelledby="account-dialog-heading" ref={dialog} onClick={event => { if (event.target === event.currentTarget) event.currentTarget.close() }}><div className="account-dialog-content"><div className="account-dialog-header"><h2 id="account-dialog-heading">내 계정</h2><button className="icon-button" aria-label="계정 창 닫기" type="button" onClick={() => dialog.current?.close()}><X size={20} /></button></div><AccountPanel /></div></dialog>
    {children}
    <nav aria-label="주 메뉴" className="bottom-nav">{links.map(({ href, label, icon: Icon, active }) => <Link key={href} href={href} aria-current={active ? 'page' : undefined}><Icon size={22} /><span>{label}</span></Link>)}</nav>
  </main></AccountContext.Provider></RealtimeProvider>
}
