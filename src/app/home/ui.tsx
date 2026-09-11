'use client'

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { CircleUserRound, History, House, Menu, Users, X } from 'lucide-react'
import { ApiError, apiRequest, discardBankAccountRequests, discardPendingRequest } from '../../lib/api-client'
import { BANKS, TEST_BANKS, type RegisteredBankAccount } from '../../lib/bank-account'
import type { RoundStatus } from '../../lib/domain-types'
import { parseInvalidateEvent, realtimeUserChannel, resourceKeysForPath, type ResourceKey } from '../../lib/realtime'

type RealtimeSubscribe = (key: ResourceKey, listener: () => void) => () => void
const RealtimeContext = createContext<RealtimeSubscribe | null>(null)

export type Account = {
  id: string; displayName: string | null; email: string | null; profileImageUrl: string | null;
  onboardingCompletedAt: number | null; deletedAt: number | null; purpose: 'app' | 'onboarding';
  bankVersion: number;
  bankAccount: { bankCode: string | null; bankName: string; accountNumber: string; accountHolder: string; verifiedAt: number | null } | null;
  openBanking: { status: 'NOT_CONNECTED' | 'CONNECTED' | 'REAUTH_REQUIRED' | 'DISCONNECT_PENDING' | 'DISCONNECTED'; authenticatedAt: number | null; environment: 'test' | 'production' }
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
    {(message || path.startsWith('/invites/')) && <p className="help-text" role="status">{message || '링크를 받은 사람이 로그인 후 초대를 수락하면 모임에 참여해요.'}</p>}
  </div>
}

const AccountContext = createContext<{ account: Account; reloadAccount: () => Promise<Account | null> } | null>(null)
export function useAccount() {
  const value = useContext(AccountContext)
  if (!value) throw new Error('Account provider required')
  return value
}

export function BankSaveMode({ verify, disabled, onChange }: { verify: boolean; disabled: boolean; onChange: (verify: boolean) => void }) {
  const id = useId()
  return <fieldset className="member-picker stack" disabled={disabled}><legend>계좌 저장 방법</legend>
    <label className="check-row"><input checked={!verify} name={`${id}-mode`} onChange={() => onChange(false)} type="radio" /><span>계좌 먼저 저장</span></label>
    <label className="check-row"><input checked={verify} name={`${id}-mode`} onChange={() => onChange(true)} type="radio" /><span>금융결제원으로 확인</span></label>
    <p className="help-text">계좌를 먼저 저장해 이용할 수 있어요. 금융결제원 연결과 계좌 확인은 나중에 진행해도 돼요.</p>
  </fieldset>
}

export function BankFields({ disabled, error, onReadyChange, onAccountChange, onConnectionChange, environment, verifyWithOpenBanking, account }: { disabled?: boolean; error?: Error | null; onReadyChange: (ready: boolean) => void; onAccountChange: () => void; onConnectionChange: () => Promise<unknown>; environment: 'test' | 'production'; verifyWithOpenBanking: boolean; account?: Account['bankAccount'] }) {
  const id = useId()
  const resource = useResource<{ accounts: RegisteredBankAccount[] }>(verifyWithOpenBanking ? '/api/me/openbanking/accounts' : null)
  const [selection, setSelection] = useState('')
  const [inputKey, setInputKey] = useState(0)
  const accounts = resource.data?.accounts ?? []
  const manual = !verifyWithOpenBanking || selection === 'manual'
  const selected = manual ? undefined : accounts.length === 1 ? accounts[0] : accounts.find(account => account.fintechUseNum === selection)
  const ready = !verifyWithOpenBanking || !resource.loading && !resource.error && Boolean(manual || selected)
  const banks = environment === 'test' ? [...BANKS, ...TEST_BANKS] : BANKS
  const fields = useRef<HTMLDivElement>(null)
  const handledConnectionError = useRef<Error | null>(null)
  useEffect(() => { onReadyChange(ready); return () => onReadyChange(false) }, [ready, onReadyChange])
  useEffect(() => {
    if (!(resource.error instanceof ApiError) || !['openbanking_required', 'openbanking_reauth_required', 'openbanking_disconnect_pending'].includes(resource.error.code) || handledConnectionError.current === resource.error) return
    handledConnectionError.current = resource.error
    onAccountChange()
    void onConnectionChange()
  }, [resource.error, onAccountChange, onConnectionChange])
  useEffect(() => {
    if (!(error instanceof ApiError)) return
    const detail = error.details as { field?: unknown } | undefined
    const field = error.code === 'account_holder_mismatch' ? 'accountHolder' : error.code === 'bank_account_unverified' ? 'accountNumber' : detail?.field
    if (typeof field === 'string' && ['bankCode', 'accountNumber', 'birthDate', 'accountHolder'].includes(field)) {
      const target = fields.current?.querySelector<HTMLElement>(`[name="${field}"]:not([type="hidden"])`) ?? fields.current?.querySelector<HTMLElement>('[data-registered-account]')
      target?.focus()
    }
  }, [error])
  function reload() {
    onAccountChange(); onReadyChange(false); setInputKey(key => key + 1)
    void resource.reload()
  }
  function select(value: string) { onAccountChange(); setSelection(value) }
  return <div className="stack" ref={fields}>
    {resource.loading && <Loading text="연결된 계좌를 불러오고 있어요…" />}
    <ErrorNotice error={resource.error} retry={reload} />
    {verifyWithOpenBanking && !resource.loading && !resource.error && accounts.length === 0 && <div className="notice"><p>등록된 계좌가 없어요. 목록을 다시 확인하거나 사용할 계좌를 직접 입력해 주세요.</p><button className="text-button" disabled={disabled} onClick={reload} type="button">계좌 목록 다시 불러오기</button></div>}
    {verifyWithOpenBanking && !resource.loading && !resource.error && accounts.length > 1 && <label className="field" htmlFor={`${id}-account`}><span>정산받을 계좌</span><select disabled={disabled} id={`${id}-account`} required value={selection} onChange={event => select(event.currentTarget.value)}><option value="" disabled>계좌를 선택해 주세요</option>{accounts.map(account => <option key={account.fintechUseNum} value={account.fintechUseNum}>{account.bankName} · {account.accountNumberMasked} · {account.accountHolder}</option>)}<option value="manual">다른 계좌 직접 입력</option></select></label>}
    {verifyWithOpenBanking && !resource.loading && !resource.error && accounts.length <= 1 && (!manual || accounts.length === 1) && <button className="text-button" disabled={disabled} onClick={() => select(manual ? '' : 'manual')} type="button">{manual ? '등록 계좌로 돌아가기' : '다른 계좌 직접 입력'}</button>}
    {ready && <div className="stack" key={`${manual ? 'manual' : selected!.fintechUseNum}:${inputKey}`}>
      {manual ? <label className="field" htmlFor={`${id}-bank`}><span>은행</span><select autoComplete="off" defaultValue={!verifyWithOpenBanking ? account?.bankCode ?? '' : ''} disabled={disabled} id={`${id}-bank`} name="bankCode" required><option value="" disabled>은행을 선택해 주세요</option>{banks.map(bank => <option key={bank.code} value={bank.code}>{bank.name}</option>)}</select></label> : <><div className="notice" data-registered-account tabIndex={-1}><p>{selected!.bankName} · {selected!.accountNumberMasked}</p><p>예금주 {selected!.accountHolder}</p><p className="help-text">아래 정보를 제출해 계좌를 확인해 주세요.</p></div><input name="bankCode" type="hidden" value={selected!.bankCode} /><input name="accountHolder" type="hidden" value={selected!.accountHolder} /></>}
      {selected?.accountNumber ? <input name="accountNumber" type="hidden" value={selected.accountNumber} /> : <label className="field" htmlFor={`${id}-number`}><span>전체 계좌번호</span><input autoComplete="off" defaultValue={!verifyWithOpenBanking ? account?.accountNumber ?? '' : ''} disabled={disabled} id={`${id}-number`} inputMode="numeric" maxLength={64} name="accountNumber" pattern={String.raw`[0-9 \-]+`} required />{!manual && <small>연결된 계좌의 전체 번호를 입력해 주세요.</small>}</label>}
      {verifyWithOpenBanking && <label className="field" htmlFor={`${id}-birth`}><span>생년월일</span><input autoComplete="off" disabled={disabled} id={`${id}-birth`} name="birthDate" required type="date" /><small>계좌 확인에만 사용하고 저장하지 않아요.</small></label>}
      {manual && <label className="field" htmlFor={`${id}-holder`}><span>예금주</span><input autoComplete="off" defaultValue={!verifyWithOpenBanking ? account?.accountHolder ?? '' : ''} disabled={disabled} id={`${id}-holder`} maxLength={100} name="accountHolder" required /></label>}
      {!verifyWithOpenBanking && (!account?.verifiedAt ? <p className="notice notice-warning">확인되지 않은 계좌입니다.</p> : <p className="help-text">계좌 정보를 변경하면 다시 확인이 필요해요.</p>)}
    </div>}
  </div>
}
export function bankValues(form: HTMLFormElement, verifyWithOpenBanking: boolean) {
  const values = new FormData(form)
  return { bankCode: String(values.get('bankCode') ?? ''), accountNumber: String(values.get('accountNumber') ?? ''), accountHolder: String(values.get('accountHolder') ?? ''), verifyWithOpenBanking, ...(verifyWithOpenBanking ? { birthDate: String(values.get('birthDate') ?? '') } : {}) }
}

export function useBankForm(path: '/api/me/bank-account' | '/api/me/onboarding') {
  const form = useRef<HTMLFormElement>(null)
  const controller = useRef<AbortController | null>(null)
  const clear = useCallback(() => {
    const birthDate = form.current?.elements.namedItem('birthDate')
    if (birthDate instanceof HTMLInputElement) birthDate.value = ''
    controller.current?.abort()
    discardPendingRequest(path, path.endsWith('/onboarding') ? 'POST' : 'PUT')
  }, [path])
  useEffect(() => {
    const resume = (event: PageTransitionEvent) => { if (event.persisted) window.location.reload() }
    window.addEventListener('pagehide', clear)
    window.addEventListener('pageshow', resume)
    return () => { window.removeEventListener('pagehide', clear); window.removeEventListener('pageshow', resume); clear() }
  }, [clear])
  const signal = () => { controller.current = new AbortController(); return controller.current.signal }
  return { form, clear, signal }
}

export function OpenBankingConnection({ account, busy, connect, reload }: { account: Account; busy: boolean; connect: () => void; reload: () => void }) {
  const status = account.openBanking.status
  if (status === 'CONNECTED') return <p className="help-text">금융결제원 연결이 유지되고 있어요. 아래 계좌를 확인해 저장해 주세요.</p>
  if (status === 'DISCONNECT_PENDING') return <div className="notice" role="status"><p>이전 계정의 금융결제원 연결을 정리하고 있어요. 정리가 끝나면 다시 연결할 수 있어요.</p><button className="text-button" disabled={busy} onClick={reload} type="button">연결 상태 확인</button></div>
  return <div className="stack"><p className="help-text">{status === 'REAUTH_REQUIRED' ? '금융결제원 인증을 다시 진행해 주세요.' : '먼저 금융결제원에서 계좌 연결에 동의해 주세요.'}</p><button className="primary-button" disabled={busy} onClick={connect} type="button">{busy ? '연결 준비 중…' : '계좌 연결하기'}</button></div>
}

export function openBankingCallbackError(code: string | null): Error | null {
  if (!code) return null
  const messages: Record<string, string> = {
    access_denied: '금융결제원 인증을 취소했어요. 계좌 연결하기를 눌러 다시 진행할 수 있어요.',
    openbanking_cancelled: '금융결제원 인증을 취소했어요. 계좌 연결하기를 눌러 다시 진행할 수 있어요.',
    openbanking_disconnect_pending: '이전 금융결제원 연결을 정리하고 있어요. 잠시 후 연결 상태를 확인해 주세요.',
    openbanking_provider_pending: '금융기관에서 이전 탈퇴를 처리하고 있어요. 익영업일 중 처리가 끝난 뒤 다시 연결해 주세요.',
    unauthorized: '인증을 시작한 로그인 상태가 만료됐어요. 다시 로그인해 주세요.',
  }
  return new Error(messages[code] ?? '금융결제원 인증을 완료하지 못했어요. 연결 상태를 확인한 뒤 다시 진행해 주세요.')
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

export function AccountPanel({ callbackError = null, initialVerify = false }: { callbackError?: Error | null; initialVerify?: boolean }) {
  const { account, reloadAccount } = useAccount()
  const action = useAction()
  const bankForm = useBankForm('/api/me/bank-account')
  const [draftVersion, setDraftVersion] = useState(account.bankVersion)
  const [formKey, setFormKey] = useState(0)
  const [bankReady, setBankReady] = useState(false)
  const [verify, setVerify] = useState(initialVerify)
  const [ready, setReady] = useState(false)
  const [saved, setSaved] = useState(false)
  const [blockedRounds, setBlockedRounds] = useState<{ id: string; name: string; groupName?: string }[]>([])
  const [withdrawn, setWithdrawn] = useState(false)
  const connected = account.openBanking.status === 'CONNECTED'
  function changeMode(value: boolean) {
    bankForm.clear(); setBankReady(false); setFormKey(key => key + 1); setVerify(value); action.setError(null); setSaved(false)
  }
  useEffect(() => {
    let active = true
    void reloadAccount().then(latest => {
      if (!active) return
      if (latest) { setDraftVersion(latest.bankVersion); setFormKey(key => key + 1); setReady(true) }
      else action.setError(new Error('저장된 계좌를 확인하지 못했어요. 다시 불러와 주세요.'))
    })
    return () => { active = false }
  }, [reloadAccount, action.setError])
  async function connect() {
    bankForm.clear()
    const result = await action.run(() => apiRequest<{ authorizationUrl?: string; returnTo?: string }>('/api/me/openbanking', { method: 'POST', body: { context: 'settings', returnTo: `${window.location.pathname}${window.location.search}` } }))
    if (result?.authorizationUrl) window.location.assign(result.authorizationUrl)
    else if (result) await reloadAccount()
  }
  async function reloadLatest() {
    bankForm.clear()
    const latest = await reloadAccount()
    if (latest) { setDraftVersion(latest.bankVersion); setFormKey(key => key + 1); setReady(true); action.setError(null); setSaved(false) }
  }
  async function save(form: HTMLFormElement) {
    if (!ready || !bankReady) return
    setSaved(false)
    const result = await action.run(async () => {
      try { return await apiRequest<{ id: string; bankVersion: number }>('/api/me/bank-account', { method: 'PUT', body: { ...bankValues(form, verify), expectedBankVersion: draftVersion }, signal: bankForm.signal() }) }
      catch (error) {
        if (error instanceof ApiError && ['openbanking_required', 'openbanking_reauth_required', 'openbanking_disconnect_pending'].includes(error.code)) { bankForm.clear(); await reloadAccount() }
        throw error
      }
    })
    if (result) {
      bankForm.clear(); setReady(false)
      const latest = await reloadAccount()
      if (latest) { setSaved(true); setDraftVersion(latest.bankVersion); setFormKey(key => key + 1); setReady(true) }
      else action.setError(new Error('계좌를 저장했지만 최신 정보를 불러오지 못했어요. 저장된 계좌를 다시 불러와 주세요.'))
    }
  }
  async function logout() {
    bankForm.clear()
    discardBankAccountRequests()
    const result = await action.run(() => apiRequest('/api/auth/logout', { method: 'POST' }))
    if (result) window.location.assign('/login')
  }
  async function withdraw() {
    if (!window.confirm('진행 중인 회차가 있으면 탈퇴할 수 없어요. 탈퇴 후에도 과거 정산과 계좌는 보존되며, 재가입해도 기존 모임으로 자동 복귀하지 않아요. 생성한 모임의 관리 권한도 복구되지 않아요. 탈퇴할까요?')) return
    setBlockedRounds([])
    await action.run(async () => {
      try {
        const result = await apiRequest<{ ok: boolean; openBankingDisconnect: 'completed' | 'pending' }>('/api/auth/withdraw', { method: 'POST' })
        bankForm.clear(); discardBankAccountRequests()
        if (result.openBankingDisconnect === 'pending') setWithdrawn(true)
        else window.location.assign('/')
      }
      catch (error) {
        if (error instanceof ApiError && error.code === 'unfinished_rounds') {
          const details = error.details as { rounds?: { id: string; name: string; groupName?: string }[] } | undefined
          setBlockedRounds(details?.rounds ?? [])
        }
        throw error
      }
    })
  }
  if (withdrawn) return <div className="notice" role="status"><p>회원탈퇴가 완료됐어요. 금융결제원 연결은 정리 중이며 자동으로 다시 시도해요. 정리가 끝나면 재가입할 수 있어요.</p><Link href="/">처음으로</Link></div>
  return <div className="stack">
    <div className="account-provider"><span className="account-avatar">{account.profileImageUrl ? <img alt="" height={56} width={56} referrerPolicy="no-referrer" src={account.profileImageUrl} /> : <CircleUserRound size={28} />}</span><div><strong>{account.displayName ?? '카카오 사용자'}</strong><p className="help-text">{account.email}</p></div></div>
    <h3>내 계좌</h3>
    {account.bankAccount && <div className="notice"><p>{account.bankAccount.bankName} · {account.bankAccount.accountNumber} · {account.bankAccount.accountHolder}</p><p className="help-text">{account.bankAccount.verifiedAt ? `금융결제원 계좌 확인 완료 · ${new Date(account.bankAccount.verifiedAt * 1000).toLocaleString('ko-KR')}` : '확인되지 않은 계좌입니다.'}</p></div>}
    <BankSaveMode verify={verify} disabled={action.busy || !ready} onChange={changeMode} />
    {verify && <><ErrorNotice error={callbackError} /><OpenBankingConnection account={account} busy={action.busy || !ready} connect={() => void connect()} reload={() => void reloadLatest()} /></>}
    {(!verify || connected) && <form aria-busy={action.busy} autoComplete="off" className="stack" ref={bankForm.form} onSubmit={event => { event.preventDefault(); void save(event.currentTarget) }}>
      <BankFields key={formKey} disabled={action.busy || !ready} error={action.error} onReadyChange={setBankReady} onAccountChange={bankForm.clear} onConnectionChange={reloadAccount} environment={account.openBanking.environment} verifyWithOpenBanking={verify} account={account.bankAccount} />
      <p className="help-text">{verify ? '계좌실명조회와 예금주 확인 후 저장해요.' : '입력한 은행·계좌번호·예금주를 저장해요.'} 받을 돈이 있는 정산에는 최신 계좌가 표시돼요.</p>
      <button className="primary-button" disabled={action.busy || !ready || !bankReady} type="submit">{action.busy ? verify ? '계좌 확인 중…' : '계좌 저장 중…' : !ready ? '저장된 계좌 확인 중…' : verify ? '계좌 확인하고 저장' : '계좌 저장'}</button>
      <button className="text-button" disabled={action.busy} onClick={() => void reloadLatest()} type="button">입력 취소하고 저장된 계좌 보기</button>
      {saved && <p className="notice" role="status">{verify ? '계좌를 확인하고 저장했어요.' : '계좌를 저장했어요.'}</p>}
    </form>}<ErrorNotice error={action.error} retry={!ready || action.error instanceof ApiError && action.error.code === 'bank_account_conflict' ? () => void reloadLatest() : undefined} />
    {blockedRounds.length > 0 && <div className="notice"><strong>먼저 종료해야 하는 회차</strong><ul>{blockedRounds.map(round => <li key={round.id}><Link href={`/home/rounds/${round.id}`}>{round.groupName ? `${round.groupName} · ` : ''}{round.name}</Link></li>)}</ul></div>}
    <button className="secondary-button" disabled={action.busy} onClick={() => void logout()} type="button">로그아웃</button>
    <button className="secondary-button danger-outline-button" disabled={action.busy} onClick={() => void withdraw()} type="button">회원 탈퇴</button>
  </div>
}

export function AppShell({ children, realtimeEnabled }: { children: ReactNode; realtimeEnabled: boolean }) {
  const pathname = usePathname() ?? '/home'
  const me = useResource<Account>('/api/me')
  const dialog = useRef<HTMLDialogElement>(null)
  const [accountOpen, setAccountOpen] = useState(false)
  const [verifyAccount, setVerifyAccount] = useState(false)
  const [callbackError, setCallbackError] = useState<Error | null>(null)
  const account = me.data
  useEffect(() => {
    if (account && (account.purpose === 'onboarding' || !account.onboardingCompletedAt || account.deletedAt)) window.location.replace(`/onboarding?returnTo=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`)
  }, [account])
  useEffect(() => {
    dialog.current?.close()
    setAccountOpen(false)
    setVerifyAccount(false)
    setCallbackError(null)
  }, [pathname])
  useEffect(() => {
    if (!account || account.purpose !== 'app' || !account.onboardingCompletedAt || account.deletedAt) return
    const url = new URL(window.location.href)
    if (url.searchParams.get('account') !== '1') return
    setCallbackError(openBankingCallbackError(url.searchParams.get('openbanking_error')))
    setVerifyAccount(url.searchParams.get('verify') === '1')
    setAccountOpen(true)
    url.searchParams.delete('account'); url.searchParams.delete('openbanking_error'); url.searchParams.delete('verify')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }, [account])
  useEffect(() => { if (accountOpen) dialog.current?.showModal() }, [accountOpen])
  if (!account || account.purpose !== 'app' || !account.onboardingCompletedAt || account.deletedAt) return <main className="app-shell"><Link className="brand" href="/">다모아</Link><Loading text="로그인 상태를 확인하고 있어요…" /><ErrorNotice error={me.error} retry={() => void me.reload()} /></main>
  const links = [
    { href: '/home', label: '홈', icon: House, active: pathname === '/home' },
    { href: '/home/groups', label: '모임', icon: Users, active: pathname.startsWith('/home/groups') || pathname.startsWith('/home/rounds') },
    { href: '/home/history', label: '정산 기록', icon: History, active: pathname === '/home/history' },
    { href: '/home/all', label: '전체', icon: Menu, active: pathname === '/home/all' },
  ]
  return <RealtimeProvider accountId={account.id} enabled={realtimeEnabled} reloadAccount={me.reload}><AccountContext.Provider value={{ account, reloadAccount: me.reload }}><main className="app-shell">
    <header className="topbar"><Link className="brand" href="/home" aria-label="다모아 홈"><img alt="다모아" height="38" src="/logo/da-moa-trans.png" width="46" /></Link><button aria-label="내 계좌와 계정" aria-haspopup="dialog" className="icon-button" onClick={() => { setVerifyAccount(false); setAccountOpen(true) }} type="button"><CircleUserRound size={24} /></button></header>
    <dialog className="account-dialog" aria-labelledby="account-dialog-heading" ref={dialog} onClose={() => { setAccountOpen(false); setCallbackError(null); setVerifyAccount(false) }} onClick={event => { if (event.target === event.currentTarget) event.currentTarget.close() }}><div className="account-dialog-content"><div className="account-dialog-header"><h2 id="account-dialog-heading">내 계정</h2><button className="icon-button" aria-label="계정 창 닫기" type="button" onClick={() => dialog.current?.close()}><X size={20} /></button></div>{accountOpen && <AccountPanel callbackError={callbackError} initialVerify={verifyAccount} />}</div></dialog>
    {children}
    <nav aria-label="주 메뉴" className="bottom-nav">{links.map(({ href, label, icon: Icon, active }) => <Link key={href} href={href} aria-current={active ? 'page' : undefined}><Icon size={22} /><span>{label}</span></Link>)}</nav>
  </main></AccountContext.Provider></RealtimeProvider>
}
