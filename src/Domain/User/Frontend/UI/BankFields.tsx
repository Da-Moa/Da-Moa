'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ApiError, discardPendingRequest, SheetSelect } from '../../../../Global/Util/Frontend'
import { BANKS, formatAccountNumber, parseClipboardAccount, suggestBanks, type Account } from '../../Shared'

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
