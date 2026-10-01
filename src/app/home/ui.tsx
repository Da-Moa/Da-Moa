'use client'

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ChevronDown, ChevronLeft, CircleUserRound, History, House, Menu, Search, Users, X } from 'lucide-react'
import { ApiError, apiRequest, discardBankAccountRequests, discardPendingRequest } from '../../lib/api-client'
import { BANKS, formatAccountNumber, parseClipboardAccount, suggestBanks } from '../../lib/bank-account'
import type { RoundStatus } from '../../lib/domain-types'
import { parseInvalidateEvent, resourceKeysForPath, type ResourceKey } from '../../lib/realtime'

type RealtimeSubscribe = (key: ResourceKey, listener: () => void) => () => void
const RealtimeContext = createContext<RealtimeSubscribe | null>(null)

export type Account = {
  id: string; displayName: string | null; email: string | null; profileImageUrl: string | null;
  onboardingCompletedAt: number | null; deletedAt: number | null; purpose: 'app' | 'onboarding';
  bankVersion: number;
  bankAccount: { bankCode: string | null; bankName: string; accountNumber: string; formattedAccountNumber: string | null; accountHolder: string; verifiedAt: number | null } | null;
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

const AccountContext = createContext<{ account: Account; reloadAccount: () => Promise<Account | null> } | null>(null)
export function useAccount() {
  const value = useContext(AccountContext)
  if (!value) throw new Error('Account provider required')
  return value
}

export function SheetSelect({ label, name, title, value, onChange, options, disabled, sheetClassName, showSelectedIcon, searchPlaceholder }: {
  label: string; name: string; title: string; value: string; onChange: (value: string) => void;
  options: readonly { value: string; label: string; icon?: ReactNode; searchText?: string }[]; disabled?: boolean; sheetClassName?: string; showSelectedIcon?: boolean; searchPlaceholder?: string;
}) {
  const id = useId()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const closing = useRef(false)
  const [opened, setOpened] = useState(false)
  const [search, setSearch] = useState('')
  const filtered = options.filter(option => `${option.label} ${option.searchText ?? ''}`.toLocaleLowerCase('ko-KR').includes(search.trim().toLocaleLowerCase('ko-KR')))
  const selected = options.find(option => option.value === value)
  function open() {
    if (disabled || closing.current) return
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
        <div aria-label={`${label} 목록`} className="bank-grid" role="group">{filtered.map(option => <button aria-pressed={value === option.value} className="bank-tile" data-value={option.value} key={option.value} onClick={() => choose(option.value)} type="button">{option.icon}<span>{option.label}</span></button>)}</div>
        {filtered.length === 0 && <p className="help-text" role="status">검색 결과가 없어요.</p>}
      </div>
    </dialog>
  </>
}

export function BankFields({ disabled, error, account }: { disabled?: boolean; error?: Error | null; account?: Account['bankAccount'] }) {
  const id = useId()
  const fields = useRef<HTMLDivElement>(null)
  const [selectedBank, setSelectedBank] = useState(account?.bankCode ?? BANKS.find(bank => bank.name === account?.bankName)?.code ?? '')
  const [number, setNumber] = useState(account?.accountNumber ?? '')
  const [clipboardMessage, setClipboardMessage] = useState('')
  const [clipboardAccount, setClipboardAccount] = useState<ReturnType<typeof parseClipboardAccount>>(null)
  const clipboardReading = useRef(false)
  const candidates = suggestBanks(number)
  function formatInput(input: HTMLInputElement, bank = selectedBank, partial = true) { input.value = formatAccountNumber(bank, input.value, partial) }
  function chooseBank(code: string) {
    setSelectedBank(code)
    const input = fields.current?.querySelector<HTMLInputElement>('[name="accountNumber"]')
    if (input) formatInput(input, code)
  }
  function pasteAccount(parsed: ReturnType<typeof parseClipboardAccount>, input: HTMLInputElement) {
    setClipboardAccount(null)
    if (!parsed) { setClipboardMessage(''); return false }
    input.value = formatAccountNumber(parsed.bankCode, parsed.accountNumber)
    setNumber(parsed.accountNumber)
    setSelectedBank(parsed.bankCode ?? '')
    setClipboardMessage(parsed.bankCode ? '' : '계좌번호를 붙여 넣었어요. 은행을 선택해 주세요.')
    return true
  }
  async function readClipboard(input: HTMLInputElement) {
    if (disabled || clipboardReading.current) return
    clipboardReading.current = true
    setClipboardAccount(null)
    const previous = input.value
    try {
      const text = await navigator.clipboard.readText()
      if (!input.isConnected || input.disabled || input.value !== previous) return
      const parsed = parseClipboardAccount(text)
      setClipboardAccount(parsed?.bankCode ? parsed : null)
    } catch { setClipboardMessage('클립보드를 읽을 수 없어요. 계좌번호 칸에 직접 붙여 넣어 주세요.') }
    finally { clipboardReading.current = false }
  }
  useEffect(() => {
    if (!(error instanceof ApiError)) return
    const detail = error.details as { field?: unknown } | undefined
    if (detail?.field === 'bankCode') fields.current?.querySelector<HTMLButtonElement>('.bank-select-trigger')?.focus()
    else if (typeof detail?.field === 'string' && ['accountNumber', 'accountHolder'].includes(detail.field)) fields.current?.querySelector<HTMLElement>(`[name="${detail.field}"]`)?.focus()
  }, [error])
  return <div className="stack" ref={fields}>
    <label className="field line-field" htmlFor={`${id}-number`}><span>계좌번호</span><input autoComplete="off" defaultValue={account ? account.formattedAccountNumber ?? formatAccountNumber(account.bankCode ?? account.bankName, account.accountNumber) : ''} disabled={disabled} id={`${id}-number`} inputMode="numeric" maxLength={64} name="accountNumber" placeholder=" " onBlur={event => formatInput(event.currentTarget, selectedBank, false)} onFocus={event => void readClipboard(event.currentTarget)} onPaste={event => {
      const text = event.clipboardData.getData('text')
      if (pasteAccount(parseClipboardAccount(text, selectedBank), event.currentTarget) || !/^[0-9 -]+$/.test(text) || text.replace(/[ -]/g, '').length >= 7) event.preventDefault()
    }} onInput={event => {
      setClipboardMessage('')
      setClipboardAccount(null)
      setNumber(event.currentTarget.value.replace(/[^0-9]/g, ''))
      if ((event.nativeEvent as InputEvent).inputType?.startsWith('delete')) return
      const input = event.currentTarget
      const before = input.value.slice(0, input.selectionStart ?? input.value.length).replace(/[ -]/g, '').length
      const previous = input.value
      formatInput(input)
      if (input.value === previous) return
      let cursor = 0, digits = 0
      while (cursor < input.value.length && digits < before) { if (input.value[cursor] !== '-') digits++; cursor++ }
      if (input.value[cursor] === '-') cursor++
      input.setSelectionRange(cursor, cursor)
    }} pattern={String.raw`[0-9 \-]+`} required /></label>
    {clipboardAccount && <button className="secondary-button" disabled={disabled} onClick={() => {
      const input = fields.current?.querySelector<HTMLInputElement>('[name="accountNumber"]')
      if (input) pasteAccount(clipboardAccount, input)
    }} type="button">{BANKS.find(bank => bank.code === clipboardAccount.bankCode)?.name} {formatAccountNumber(clipboardAccount.bankCode, clipboardAccount.accountNumber)} 붙여넣기</button>}
    {clipboardMessage && <p className="help-text" role="status">{clipboardMessage}</p>}
    <div className="stack bank-choice">
      <SheetSelect disabled={disabled || !number} label="은행 선택" name="bankCode" onChange={chooseBank} options={BANKS.map(bank => ({ value: bank.code, label: bank.name, icon: <img alt="" draggable={false} height={32} src={`/banks/${bank.code}.${bank.code === '227' ? 'png' : 'svg'}`} width={32} /> }))} title="은행을 선택해 주세요" value={selectedBank} />
      {number && (candidates.length > 0 ? <div className="bank-candidates" aria-label="계좌번호로 찾은 은행 후보"><div className="bank-candidate-list">{candidates.map(code => <button aria-pressed={selectedBank === code} className="bank-candidate" disabled={disabled} key={code} onClick={() => chooseBank(code)} type="button"><img alt="" draggable={false} height={20} src={`/banks/${code}.${code === '227' ? 'png' : 'svg'}`} width={20} />{BANKS.find(bank => bank.code === code)?.name}</button>)}</div></div> : <p className="help-text">은행을 직접 선택해 주세요.</p>)}
    </div>
    <label className="field line-field" htmlFor={`${id}-holder`}><span>예금주</span><input autoComplete="off" defaultValue={account?.accountHolder ?? ''} disabled={disabled} id={`${id}-holder`} maxLength={100} name="accountHolder" placeholder=" " required /></label>
  </div>
}
export function bankValues(form: HTMLFormElement) {
  const values = new FormData(form)
  return { bankCode: String(values.get('bankCode') ?? ''), accountNumber: String(values.get('accountNumber') ?? ''), accountHolder: String(values.get('accountHolder') ?? '') }
}

export function useBankForm(path: '/api/me/bank-account' | '/api/me/onboarding') {
  const form = useRef<HTMLFormElement>(null)
  const controller = useRef<AbortController | null>(null)
  const clear = useCallback(() => {
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
    const pending = new Set<ResourceKey>()
    const queue = (keys: ResourceKey[]) => {
      if (disposed) return
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
    const retry = (event?: CloseEvent) => {
      if (disposed) return
      reconnect = setTimeout(() => { void connect() }, event?.code === 4001 ? 0 : Math.min(30000, 1000 * 2 ** Math.min(attempts++, 5)))
    }
    const connect = async () => {
      try {
        const account = await apiRequest<Account>('/api/me')
        if (disposed) return
        if (account.id !== accountId) { window.location.reload(); return }
        socket = new WebSocket(`${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/realtime`)
        socket.onopen = () => { attempts = 0; queue(['me', ...listeners.current.keys()]) }
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

export function AccountPanel() {
  const { account, reloadAccount } = useAccount()
  const action = useAction()
  const bankForm = useBankForm('/api/me/bank-account')
  const [draftVersion, setDraftVersion] = useState(account.bankVersion)
  const [formKey, setFormKey] = useState(0)
  const [ready, setReady] = useState(false)
  const [saved, setSaved] = useState(false)
  const [editingBank, setEditingBank] = useState(false)
  const bankToggle = useRef<HTMLButtonElement>(null)
  const [blockedRounds, setBlockedRounds] = useState<{ id: string; name: string; groupName?: string }[]>([])
  useEffect(() => {
    let active = true
    void reloadAccount().then(latest => {
      if (!active) return
      if (latest) { setDraftVersion(latest.bankVersion); setFormKey(key => key + 1); setReady(true) }
      else action.setError(new Error('저장된 계좌를 확인하지 못했어요. 다시 불러와 주세요.'))
    })
    return () => { active = false }
  }, [reloadAccount, action.setError])
  useEffect(() => {
    if (!saved) return
    const timer = window.setTimeout(() => setSaved(false), 3000)
    return () => window.clearTimeout(timer)
  }, [saved])
  useEffect(() => {
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
    if (editingBank) bankForm.form.current?.parentElement?.scrollIntoView({ behavior, block: 'start' })
    else window.scrollTo({ top: 0, behavior })
  }, [editingBank, bankForm.form])
  async function reloadLatest() {
    bankForm.clear()
    const latest = await reloadAccount()
    if (latest) { setDraftVersion(latest.bankVersion); setFormKey(key => key + 1); setReady(true); action.setError(null); setSaved(false) }
  }
  function cancelBankEdit() {
    bankForm.clear(); action.setError(null); setSaved(false); setEditingBank(false)
    bankToggle.current?.focus({ preventScroll: true })
  }
  async function save(form: HTMLFormElement) {
    if (!ready) return
    setSaved(false)
    const result = await action.run(() => apiRequest<{ id: string; bankVersion: number }>('/api/me/bank-account', { method: 'PUT', body: { ...bankValues(form), expectedBankVersion: draftVersion }, signal: bankForm.signal() }))
    if (result) {
      bankForm.clear(); setReady(false)
      const latest = await reloadAccount()
      if (latest) { setDraftVersion(latest.bankVersion); setFormKey(key => key + 1); setReady(true); cancelBankEdit(); setSaved(true) }
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
        await apiRequest<{ ok: boolean }>('/api/auth/withdraw', { method: 'POST' })
        bankForm.clear(); discardBankAccountRequests()
        window.location.assign('/')
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
  return <div className="stack account-page">
    {saved && <p className="notice account-save-toast" role="status">계좌를 저장했어요.</p>}
    <header className="account-page-heading"><Link aria-label="전체로 돌아가기" className="icon-button back-button back-link" href="/home/all"><ChevronLeft aria-hidden="true" size={38} strokeWidth={2.5} /></Link><h1>내 정보</h1></header>
    <section className="domain-card account-profile" aria-labelledby="account-profile-heading">
      <span className="account-avatar">{account.profileImageUrl ? <img alt="" height={80} width={80} referrerPolicy="no-referrer" src={account.profileImageUrl} /> : <CircleUserRound size={40} />}</span>
      <h2 id="account-profile-heading">{account.displayName ?? '카카오 사용자'}님의 정보</h2>
      <dl className="account-details"><div><dt>이름</dt><dd>{account.displayName ?? '카카오 사용자'}</dd></div>{account.email && <div><dt>이메일</dt><dd>{account.email}</dd></div>}<div><dt>계좌</dt><dd>{account.bankAccount ? `${account.bankAccount.bankName} · ${account.bankAccount.formattedAccountNumber ?? formatAccountNumber(account.bankAccount.bankCode ?? account.bankAccount.bankName, account.bankAccount.accountNumber)}` : '등록된 계좌가 없어요.'}</dd></div></dl>
      <button aria-expanded={editingBank} className="secondary-button account-bank-toggle" disabled={action.busy} onClick={() => { if (editingBank) cancelBankEdit(); else { setDraftVersion(account.bankVersion); setEditingBank(true) } }} ref={bankToggle} type="button">{editingBank ? '계좌 수정 닫기' : '계좌 수정하기'}</button>
    </section>
    {editingBank && <section className="domain-card stack" id="bank-settings" aria-label="계좌 수정">
    <form aria-busy={action.busy} autoComplete="off" className="stack" ref={bankForm.form} onSubmit={event => { event.preventDefault(); void save(event.currentTarget) }}>
      <BankFields key={formKey} disabled={action.busy || !ready} error={action.error} account={account.bankAccount} />
      <button className="primary-button" disabled={action.busy || !ready} type="submit">{action.busy ? '계좌 저장 중…' : !ready ? '저장된 계좌 확인 중…' : '계좌 저장'}</button>
      <button className="secondary-button danger-outline-button" disabled={action.busy} onClick={cancelBankEdit} type="button">취소</button>
    </form><ErrorNotice error={action.error} retry={!ready || action.error instanceof ApiError && action.error.code === 'bank_account_conflict' ? () => void reloadLatest() : undefined} />
    </section>}
    <section className="domain-card stack" aria-labelledby="account-management-heading"><h2 id="account-management-heading">계정 관리</h2>
    {blockedRounds.length > 0 && <div className="notice"><strong>먼저 종료해야 하는 회차</strong><ul>{blockedRounds.map(round => <li key={round.id}><Link href={`/home/rounds/${round.id}`}>{round.groupName ? `${round.groupName} · ` : ''}{round.name}</Link></li>)}</ul></div>}
    <button className="secondary-button" disabled={action.busy} onClick={() => void logout()} type="button">로그아웃</button>
    <button className="secondary-button danger-outline-button" disabled={action.busy} onClick={() => void withdraw()} type="button">회원 탈퇴</button>
    </section>
  </div>
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/home'
  const hasBackButton = pathname === '/home/account' || pathname.startsWith('/home/groups/') || pathname.startsWith('/home/rounds/') || pathname.startsWith('/settlements/')
  const tabTitle = pathname === '/home/groups' ? '내 모임' : pathname === '/home/history' ? '정산 기록' : pathname === '/home/all' ? '전체' : null
  const topbarContent = pathname === '/home' ? <Link className="brand" href="/home" aria-label="다모아 홈"><img alt="다모아" height="38" src="/logo/da-moa-trans.png" width="46" /></Link> : tabTitle ? <h1 className="topbar-title">{tabTitle}</h1> : pathname.startsWith('/invites/') ? <span className="topbar-title">모임 초대</span> : null
  const me = useResource<Account>('/api/me')
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
  return <RealtimeProvider accountId={account.id} reloadAccount={me.reload}><AccountContext.Provider value={{ account, reloadAccount: me.reload }}><main className="app-shell">
    <header className="topbar">{topbarContent}</header>
    {children}
    <nav aria-label="주 메뉴" className="bottom-nav">{links.map(({ href, label, icon: Icon, active }) => <Link key={href} href={href} aria-current={active ? 'page' : undefined}><Icon size={22} /><span>{label}</span></Link>)}</nav>
  </main></AccountContext.Provider></RealtimeProvider>
}
