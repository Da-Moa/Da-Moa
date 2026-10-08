'use client'

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowRight, ChevronDown, ChevronLeft, ImagePlus, Pencil, Plus, Trash2 } from 'lucide-react'
import { CurrencySelect, CurrencyDivider } from './currencySelect'
import { AnimatedMoney } from './animatedMoney'
import { ApiError, apiRequest } from '../../../global/util'
import type { ExclusionCheck, Expense, MutationResult, Receipt, RoundDetail, Currency } from '../../../../shared/domain/settle'
import { amountInputPattern, currencyDecimals, expenseInputMaximum, formatAmountInput, formatMoney, minorToAmount, parseAmount } from '../../../../shared/domain/settle'
import { BottomSheet, Loading, ParticipantAvatar, SheetSelect, useAction, useResource } from '../../../global/util'
import { useAccount } from '../../user'
import { StatusBadge } from './statusBadge'
import { ErrorNotice } from './errorNotice'
import { encodeReceipt } from '../receiptEncoder'

const expenseDayFormatter = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' })
function expenseDay(createdAt: number) {
  const date = new Date(createdAt * 1000)
  const dateTime = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  return { dateTime, label: expenseDayFormatter.format(date) }
}

function ExpenseForm({ round, expense, onSaved, onCancel, reload, saving }: { round: RoundDetail; expense: Expense | null; onSaved: (result: MutationResult) => void; onCancel: () => void; reload: () => Promise<RoundDetail | null>; saving: boolean }) {
  const { account } = useAccount()
  const action = useAction()
  const busy = action.busy || saving
  const expectedVersion = useRef(round.version)
  const [mode, setMode] = useState<Expense['splitMode']>(expense?.splitMode ?? 'ALL')
  const [participants, setParticipants] = useState(expense?.participantIds ?? [])
  const [payerId, setPayerId] = useState(expense?.payerId ?? account.id)
  const [currency, setCurrency] = useState<Currency>(expense?.currency ?? round.totals[0]?.currency ?? 'KRW')
  const payerOptions = useMemo(() => round.members.filter(member => !member.excludedAt || member.userId === expense?.payerId).map(member => ({ value: member.userId, label: `${member.displayName}${member.excludedAt ? ' (제외됨 · 기존 결제 유지)' : ''}`, icon: <ParticipantAvatar profileImageUrl={member.profileImageUrl} /> })), [round.members, expense?.payerId])
  const maximumMinor = expenseInputMaximum(round.totals.find(total => total.currency === currency)?.totalMinor ?? '0', expense?.currency === currency ? expense.amountMinor : null, currency)
  function minorToInput(minor: string) {
    const amount = minor ? minorToAmount(minor, currency) : ''
    return formatAmountInput(amount, currency) ?? amount
  }
  const [amountInput, setAmountInput] = useState(() => minorToInput(expense?.amountMinor ?? ''))
  const [customAmounts, setCustomAmounts] = useState<Record<string, string>>(() => Object.fromEntries((expense?.shares ?? []).flatMap(share => share.assignedAmountMinor == null ? [] : [[share.userId, minorToInput(share.assignedAmountMinor)]])))
  useEffect(() => setAmountInput(current => formatAmountInput(current, currency, maximumMinor) ?? current), [maximumMinor, currency])
  const changeCurrency = useCallback((next: Currency) => {
    if (next === currency) return
    setCurrency(next)
    setAmountInput('')
    setCustomAmounts({})
    action.setError(null)
  }, [currency, action.setError])
  async function save(form: HTMLFormElement) {
    if (saving || maximumMinor === 0n) return
    const values = new FormData(form)
    const body = {
      currency, description: String(values.get('description') ?? ''), amount: String(values.get('amount') ?? '').replace(/,/g, ''), payerId: String(values.get('payerId') ?? ''), splitMode: mode,
      ...(mode === 'SELECTED' ? { participantIds: values.getAll('participantIds').map(String) } : {}),
      ...(mode === 'CUSTOM' ? { customShares: values.getAll('participantIds').map(value => ({ userId: String(value), amount: String(values.get(`customAmount:${value}`) ?? '').replace(/,/g, '') })) } : {}),
      expectedVersion: expectedVersion.current,
    }
    const path = `/api/rounds/${round.id}/expenses${expense ? `/${expense.id}` : ''}`, method = expense ? 'PATCH' : 'POST'
    const result = await action.run(async () => {
      if (body.customShares) {
        let amount: bigint
        try { amount = parseAmount(body.amount, currency) }
        catch { throw new Error('통화에 맞는 양의 금액을 정확히 입력해 주세요') }
        let total = 0n
        try { total = body.customShares.reduce((sum, share) => sum + parseAmount(share.amount, currency), 0n) }
        catch { throw new Error('부담금은 0보다 큰 금액으로 입력해 주세요.') }
        if (total !== amount) throw new Error('부담금 합계가 총 금액과 일치해야 해요')
      }
      try { return await apiRequest<MutationResult>(path, { method, body }) }
      catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'stale_round') throw error
        const latest = await reload()
        if (!latest) throw error
        expectedVersion.current = latest.version
        body.expectedVersion = latest.version
        return apiRequest<MutationResult>(path, { method, body })
      }
    })
    if (result) onSaved(result)
  }
  function changeAmount(input: HTMLInputElement, userId?: string) {
    const cursor = input.selectionStart ?? input.value.length
    const offset = input.value.slice(0, cursor).replace(/,/g, '').length
    const formatted = formatAmountInput(input.value, currency, maximumMinor)
    if (formatted === null) return
    if (userId) setCustomAmounts(current => ({ ...current, [userId]: formatted }))
    else setAmountInput(formatted)
    requestAnimationFrame(() => {
      let position = 0, remaining = offset
      while (position < formatted.length && remaining > 0) {
        if (formatted[position] !== ',') remaining--
        position++
      }
      if (input.isConnected) input.setSelectionRange(position, position)
    })
  }
  return <form aria-busy={busy} className="domain-card expense-form stack" id="expense-editor" onSubmit={event => { event.preventDefault(); void save(event.currentTarget) }}>
    <h2>{expense ? '지출 수정' : '지출 기록'}</h2>
    <label className="field line-field"><span>지출 내용</span><input autoFocus defaultValue={expense?.description ?? ''} disabled={busy} name="description" maxLength={200} placeholder=" " required /></label>
    <CurrencySelect disabled={busy} onChange={changeCurrency} value={currency} />
    <p className="help-text">한 회차에 최대 5개 통화를 기록할 수 있어요. 통화를 변경하면 금액과 개별 부담금을 다시 입력해 주세요.</p>
    <label className="field line-field"><span>총 금액 ({currency})</span><input disabled={busy} value={amountInput} onChange={event => changeAmount(event.currentTarget)} name="amount" inputMode={currencyDecimals(currency) ? 'decimal' : 'numeric'} type="text" pattern={amountInputPattern(currency)} placeholder=" " required /></label>
    <SheetSelect disabled={busy} label="실제로 결제한 사람" name="payerId" onChange={setPayerId} options={payerOptions} sheetClassName="currency-sheet" showSelectedIcon title="결제한 사람을 선택해 주세요" value={payerId} />
    <fieldset className="member-picker" disabled={busy}><legend>부담할 사람</legend>
      <label className="check-row"><input type="radio" name="splitMode" value="ALL" checked={mode === 'ALL'} onChange={() => setMode('ALL')} /><span>전체 참여자 균등 분배</span></label>
      <label className="check-row"><input type="radio" name="splitMode" value="SELECTED" checked={mode === 'SELECTED'} onChange={() => setMode('SELECTED')} /><span>특정 사용자 균등 분배</span></label>
      <label className="check-row"><input type="radio" name="splitMode" value="CUSTOM" checked={mode === 'CUSTOM'} onChange={() => setMode('CUSTOM')} /><span>개별 항목 분배</span></label>
      {mode !== 'ALL' && <div className="selected-members">{round.members.filter(member => !member.excludedAt).map(member => <div className={mode === 'CUSTOM' ? 'custom-share-row' : undefined} key={member.userId}>
        <label className="check-row"><input checked={participants.includes(member.userId)} onChange={event => setParticipants(current => event.target.checked ? [...current, member.userId] : current.filter(id => id !== member.userId))} name="participantIds" type="checkbox" value={member.userId} /><span>{member.displayName}</span></label>
        {mode === 'CUSTOM' && participants.includes(member.userId) && <label className="field line-field"><span>부담금 ({currency})</span><input aria-label={`${member.displayName} 부담금 (${currency})`} value={customAmounts[member.userId] ?? ''} onChange={event => changeAmount(event.currentTarget, member.userId)} name={`customAmount:${member.userId}`} inputMode={currencyDecimals(currency) ? 'decimal' : 'numeric'} type="text" pattern={amountInputPattern(currency)} placeholder=" " required /></label>}
      </div>)}</div>}
    </fieldset>
    {round.status !== 'RECORDING' && <p className="notice notice-warning">다른 변경으로 기록 단계가 끝났어요. 입력을 확인한 뒤 창을 닫고 최신 상태를 확인해 주세요.</p>}
    <ErrorNotice error={action.error} />
    <div className="quick-actions"><button className="primary-button" disabled={busy || round.status !== 'RECORDING' || maximumMinor === 0n} type="submit">{busy ? '저장 중…' : '지출 저장'}</button><button className="secondary-button" disabled={busy} type="button" onClick={onCancel}>닫기</button></div>
  </form>
}

function ReceiptImage({ receipt, index, canEdit, remove, busy }: { receipt: Receipt; index: number; canEdit: boolean; remove: () => void; busy: boolean }) {
  const action = useAction()
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => () => { if (url) URL.revokeObjectURL(url) }, [url])
  async function view() {
    const blob = await action.run(() => apiRequest<Blob>(`/api/receipts/${receipt.id}`, { response: 'blob' }))
    if (blob) setUrl(URL.createObjectURL(blob))
  }
  return <div className="receipt-item">
    <div className="row-between">{receipt.storageStatus === 'PENDING' || receipt.storageStatus === 'FAILED'
      ? <span role="status">{receipt.storageStatus === 'PENDING' ? `증빙 ${index + 1} 저장 중…` : `증빙 ${index + 1} 저장 실패 · 삭제 후 다시 올려 주세요`}</span>
      : <button className="text-button" disabled={action.busy} onClick={() => url ? setUrl(null) : void view()} type="button">{url ? '증빙 접기' : `증빙 ${index + 1} 보기`}</button>}{canEdit && <button aria-label={`증빙 ${index + 1} 삭제`} className="icon-button danger-text" disabled={busy} onClick={remove} type="button"><Trash2 size={17} /></button>}</div>
    <ErrorNotice error={action.error} retry={() => void view()} />
    {url && <img className="receipt-preview" src={url} alt={`지출 증빙 ${index + 1}`} />}
  </div>
}

function ExpenseCard({ expense, round, canEdit, highlighted, edit, reload }: { expense: Expense; round: RoundDetail; canEdit: boolean; highlighted: boolean; edit: () => void; reload: () => Promise<unknown> }) {
  const action = useAction()
  const uploadAction = useAction()
  const input = useRef<HTMLInputElement>(null)
  const uploadDialog = useRef<HTMLDialogElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const encodedFile = useRef<File | null>(null)
  const [encoding, setEncoding] = useState(false)
  const name = (id: string) => round.members.find(member => member.userId === id)?.displayName ?? '과거 참여자'
  async function remove() {
    if (!window.confirm('이 지출과 첨부한 증빙을 삭제할까요?')) return
    await action.run(() => apiRequest(`/api/rounds/${round.id}/expenses/${expense.id}`, { method: 'DELETE', body: { expectedVersion: round.version } }))
  }
  async function upload() {
    if (!file) return
    const result = await uploadAction.run(async () => {
      if (!encodedFile.current) {
        setEncoding(true)
        try { encodedFile.current = await encodeReceipt(file) }
        finally { setEncoding(false) }
      }
      const form = new FormData(); form.set('file', encodedFile.current); form.set('expectedVersion', String(round.version))
      return apiRequest(`/api/rounds/${round.id}/expenses/${expense.id}/receipts`, { method: 'POST', body: form })
    })
    if (result) uploadDialog.current?.close()
  }
  async function removeReceipt(id: string) {
    if (!window.confirm('이 증빙 이미지를 삭제할까요? 지출 기록은 유지돼요.')) return
    await action.run(() => apiRequest(`/api/rounds/${round.id}/expenses/${expense.id}/receipts/${id}`, { method: 'DELETE', body: { expectedVersion: round.version } }))
  }
  return <article id={`expense-${expense.id}`} tabIndex={-1} className={`domain-card expense-card stack${highlighted ? ' expense-highlight' : ''}`}>
    {highlighted && <p className="highlight-label">제외 전 수정 필요</p>}
    <div className="row-between expense-card-heading"><h3>{expense.description}</h3><strong className="money">{formatMoney(expense.amountMinor, expense.currency)}</strong></div>
    <p className="help-text"><strong>결제자:</strong> {name(expense.payerId)}</p>
    <div><span className="subtle-tag expense-split-tag">{expense.splitMode === 'ALL' ? '전체 균등 분배' : expense.splitMode === 'CUSTOM' ? '개별 항목 분배' : '특정 사용자 균등 분배'}</span><p className="burden-members"><strong>부담자:</strong> {expense.participantIds.map(name).join(', ')}</p></div>
    {(expense.splitMode === 'CUSTOM' || expense.shares.some(share => share.amountMinor !== null)) && <details><summary>{round.finalizedAt !== null ? '최종 부담액 보기' : '개별 부담금 보기'}</summary><ul className="member-list">{expense.shares.map(share => <li key={share.userId}><span>{name(share.userId)}{share.receivedRemainder && <small className="subtle-tag">나머지 부담</small>}</span><strong className="money">{formatMoney(share.amountMinor ?? share.assignedAmountMinor ?? '0', expense.currency)}</strong></li>)}</ul></details>}
    {canEdit && <div className="inline-actions expense-card-actions"><button className="text-button" disabled={action.busy} onClick={edit} type="button"><Pencil size={15} /> 수정</button><button aria-controls={`receipt-upload-${expense.id}`} aria-haspopup="dialog" className="text-button" disabled={action.busy} onClick={() => uploadDialog.current?.showModal()} type="button"><ImagePlus size={15} /> 영수증 추가</button><button className="text-button danger-text" disabled={action.busy} onClick={() => void remove()} type="button"><Trash2 size={15} /> 삭제</button></div>}
    {expense.receipts.map((receipt, index) => <ReceiptImage key={receipt.id} receipt={receipt} index={index} canEdit={canEdit} busy={action.busy} remove={() => void removeReceipt(receipt.id)} />)}
    {canEdit && <BottomSheet closeLabel="영수증 이미지 추가 팝업 닫기" dialogRef={uploadDialog} dismissible={!uploadAction.busy} id={`receipt-upload-${expense.id}`} onClose={() => { setFile(null); encodedFile.current = null; uploadAction.setError(null); if (input.current) input.current.value = '' }} subtitle="영수증 이미지" title="영수증 이미지 추가" titleId={`receipt-upload-heading-${expense.id}`}>
        <label className="field"><span>이미지 파일</span><input accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" disabled={uploadAction.busy} onChange={event => { setFile(event.target.files?.[0] ?? null); encodedFile.current = null; uploadAction.setError(null) }} ref={input} type="file" /></label>
        <p className="help-text">JPEG·PNG·WebP 이미지를 AVIF로 변환해 올려요. 변환한 파일은 10MB 이하만 사용할 수 있어요.</p>
        <button className="primary-button" disabled={!file || uploadAction.busy} onClick={() => void upload()} type="button">{encoding ? '이미지 변환 중…' : uploadAction.busy ? '업로드 중…' : '선택한 영수증 업로드'}</button>
        <ErrorNotice error={uploadAction.error} retry={uploadAction.error instanceof ApiError && uploadAction.error.code === 'stale_round' ? () => void reload() : undefined} />
    </BottomSheet>}
    <ErrorNotice error={action.error} retry={action.error instanceof ApiError && action.error.code === 'stale_round' ? () => void reload() : undefined} />
  </article>
}

const exclusionReason: Record<string, string> = {
  round_creator_cannot_leave: '회차 생성자는 제외할 수 없어요.', already_excluded: '이미 제외된 참여자예요.',
  invalid_round_state: '기록 단계 또는 전송 전 확정 단계에서만 제외를 검토할 수 있어요.',
  minimum_participants: '회차는 회차 생성자를 포함해 최소 2명이 필요해요.',
  payer_and_participant: '이 사람이 결제자이면서 부담자예요. 해당 관계를 먼저 수정해 주세요.',
  selected_participant: '특정 사용자 분배의 부담자예요. 해당 기록을 먼저 수정해 주세요.',
  custom_participant: '개별 항목 분배의 부담자예요. 해당 기록을 먼저 수정해 주세요.',
}

export default function RoundClient({ roundId }: { roundId: string }) {
  const router = useRouter()
  const { account } = useAccount()
  const resource = useResource<RoundDetail>(`/api/rounds/${roundId}`)
  const action = useAction()
  const more = useAction()
  const [editing, setEditing] = useState<Expense | 'new' | null>(null)
  const [savedExpense, setSavedExpense] = useState<MutationResult | null>(null)
  const [expensesOpen, setExpensesOpen] = useState(true)
  const [check, setCheck] = useState<(ExclusionCheck & { userId: string }) | null>(null)
  const exclusionDialog = useRef<HTMLDialogElement>(null)
  const data = resource.data
  const myself = data?.members.find(member => member.userId === account.id)
  const recording = data?.status === 'RECORDING'
  useLayoutEffect(() => {
    if (!savedExpense || !data || data.version < (savedExpense.version ?? 0)) return
    // Keep the form until the WebSocket read contains the saved version, then anchor once.
    if (editing) { setEditing(null); setCheck(null); return }
    const target = document.getElementById(`expense-${savedExpense.id}`) ?? document.getElementById('expense-section-heading')
    target?.scrollIntoView({ block: 'start', behavior: 'instant' })
    target?.focus({ preventScroll: true })
    setSavedExpense(null)
  }, [savedExpense, data, editing])
  useEffect(() => {
    if (check && !exclusionDialog.current?.open) exclusionDialog.current?.showModal()
  }, [check])
  useEffect(() => {
    if (editing) document.getElementById('expense-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [editing])
  async function refresh() {
    const updated = await resource.reload()
    return updated
  }
  async function command(name: string) {
    if (!data) return
    if (name === 'send' && !window.confirm('이대로 사용자들에게 메시지를 전송할까요?\n전송하면 기록이 잠기며 다음 화면에서 링크를 복사해 직접 공유합니다.')) return
    const result = await action.run(() => apiRequest<MutationResult>(`/api/rounds/${roundId}/${name}`, { method: 'POST', body: { expectedVersion: data.version } }))
    if (result) {
      setCheck(null)
      if (name === 'send') router.push(`/settlements/${roundId}`)
      else {
        if (name === 'confirm' || name === 'reopen') requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'smooth' }))
      }
    }
  }
  async function cancel() {
    if (!data || !window.confirm('지출 기록이 없는 회차만 취소할 수 있어요. 회차를 영구 삭제할까요? 이 작업은 되돌릴 수 없어요.')) return
    resource.suspend()
    const result = await action.run(() => apiRequest(`/api/rounds/${roundId}`, { method: 'DELETE', body: { expectedVersion: data.version } }))
    if (result) router.push(`/home/groups/${data.groupId}`)
    else await resource.resume()
  }
  async function loadMore() {
    if (!data?.expensesNextCursor) return
    const page = await more.run(() => apiRequest<RoundDetail>(`/api/rounds/${roundId}?cursor=${encodeURIComponent(data.expensesNextCursor!)}`))
    if (page) {
      if (page.version !== data.version) { more.setError(new Error('회차가 변경됐어요. 최신 내역을 새로 불러와 주세요.')); return }
      resource.setData(current => current ? { ...current, expenses: [...current.expenses, ...page.expenses.filter(expense => !current.expenses.some(existing => existing.id === expense.id))], expensesNextCursor: page.expensesNextCursor } : page)
    }
  }
  function closeEditor() {
    const targetId = editing === 'new' ? 'expense-section-heading' : editing ? `expense-${editing.id}` : null
    setEditing(null)
    if (targetId) requestAnimationFrame(() => document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }
  async function checkExclusion(userId: string) {
    const result = await action.run(() => apiRequest<ExclusionCheck>(`/api/rounds/${roundId}/members/${userId}/exclusion-check`))
    if (result) setCheck({ ...result, userId })
  }
  async function exclude() {
    if (!data || !check || !window.confirm('이 회차에서 제외할까요? 전체 균등 분배가 다시 계산돼요. 모임 참여 상태와 다른 회차는 유지돼요.')) return
    await action.run(async () => {
      try {
        await apiRequest(`/api/rounds/${roundId}/members/${check.userId}/exclude`, { method: 'POST', body: { expectedVersion: data.version } })
        exclusionDialog.current?.close(); setCheck(null)
      } catch (error) {
        if (error instanceof ApiError && error.code === 'member_exclusion_blocked') {
          const details = error.details as ExclusionCheck | undefined
          if (details?.expenses) setCheck({ ...details, userId: check.userId })
        }
        throw error
      }
    })
  }
  function revealExpense(id: string) {
    setExpensesOpen(true)
    exclusionDialog.current?.close()
    requestAnimationFrame(() => {
      const target = document.getElementById(`expense-${id}`)
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      target?.focus({ preventScroll: true })
    })
  }
  const nameOf = (id: string) => data?.members.find(member => member.userId === id)?.displayName ?? '참여자'
  const profileOf = (id: string) => data?.members.find(member => member.userId === id)?.profileImageUrl ?? null
  const finalized = Boolean(data && data.finalizedAt !== null)
  const hasExpenses = Boolean(data?.totals.length)
  const orderedExpenses = data?.expenses.slice().reverse() ?? []
  return <>
    <Link aria-label="모임으로 돌아가기" className="icon-button back-button back-link" href={data ? `/home/groups/${data.groupId}` : '/home/groups'}><ChevronLeft aria-hidden="true" size={38} strokeWidth={2.5} /></Link>
    <ErrorNotice error={resource.error} retry={() => void refresh()} />
    {!data ? resource.loading && <Loading /> : <div className="stack">
      <section className="tab-heading compact"><p>{data.groupName}</p><h1>{data.name}</h1><div className="heading-status round-heading-status"><StatusBadge status={data.status} /><button className="text-button" disabled={resource.loading} onClick={() => void refresh()} type="button">새로고침</button></div></section>
      {(data.status === 'LOCKED' || data.status === 'COMPLETED') && <div className="notice"><p>{data.status === 'COMPLETED' ? '종료된 회차예요. 모든 정산 기록은 읽기 전용이에요.' : data.finalizedAt ? '기록이 잠겼어요. 본인의 최종 정산 안내를 확인해 주세요.' : '기록이 잠겼어요. 회차 생성자가 나머지를 한 번 추첨하면 최종 금액을 확인할 수 있어요.'}</p><Link className="primary-button" href={`/settlements/${roundId}`} prefetch={false}>내 정산 안내 보기</Link></div>}
      <section className="domain-card stack"><div className="row-between"><h2>전체 지출</h2><span className="help-text">{data.memberCount}명 참여</span></div>
        {data.totals.length === 0 ? <p className="help-text">아직 지출 내역이 없어요.</p> : <ul aria-label="통화별 전체 지출" className="currency-total-list">{data.totals.map(total => <li className="row-between" key={total.currency}><span>{total.currency}</span><AnimatedMoney amountMinor={total.totalMinor} className="large-money round-total-money" currency={total.currency} key={`${data.id}:total:${total.currency}`} /></li>)}</ul>}
      </section>
      <section className="domain-card stack participant-section"><div><h2>회차 참여자</h2></div>
        <ul aria-label="회차 참여자" className="participant-grid">{data.members.map(member => {
          const canExclude = data.isCreator && member.excludedAt === null && member.userId !== data.creatorId && ['RECORDING', 'CONFIRMED'].includes(data.status)
          const selfClass = member.userId === account.id ? ' participant-me' : ''
          const card = <><ParticipantAvatar profileImageUrl={member.profileImageUrl} /><span className="participant-name"><strong>{member.displayName}{member.userId === account.id ? ' (나)' : ''}</strong><span>{member.userId === data.creatorId && <small className="subtle-tag">회차 생성자</small>}{member.excludedAt !== null && <small className="subtle-tag">제외됨 · 기록 보존</small>}</span></span></>
          return <li key={member.userId}>{canExclude ? <button aria-controls="participant-exclusion-dialog" aria-haspopup="dialog" aria-label={`${member.displayName} 제외`} className={`participant-card${selfClass}`} disabled={action.busy} onClick={() => void checkExclusion(member.userId)} type="button">{card}</button> : <div className={`participant-card${member.excludedAt !== null ? ' participant-excluded' : ''}${selfClass}`}>{card}</div>}</li>
        })}</ul>
        <div className="settlement-flow stack"><div className="row-between"><h3>나의 송금 관계</h3>{hasExpenses && <small className="subtle-tag">{finalized ? '최종' : '현재 예상'} {data.transfers.length}건</small>}</div>
          {data.transfers.length === 0 ? <p className="flow-empty" role="status">{!hasExpenses ? '지출을 기록하면 나의 예상 송금 관계를 표시해요.' : finalized ? '내가 주고받을 금액이 없어요.' : '현재 기록 기준으로 내가 주고받을 금액이 없어요.'}</p> : <div className="currency-transfer-groups">{data.totals.filter(total => data.transfers.some(transfer => transfer.currency === total.currency)).map(total => <div key={total.currency}><ul aria-label={finalized ? '나의 최종 송금 관계' : '나의 현재 예상 송금 관계'} aria-live="polite" className="transfer-list">{data.transfers.filter(transfer => transfer.currency === total.currency).map(transfer => {
            const sender = nameOf(transfer.senderId), receiver = nameOf(transfer.receiverId), amount = formatMoney(transfer.amountMinor, transfer.currency)
            return <li aria-label={`${finalized ? '최종' : '예상'} 송금, 보내는 사람 ${sender}, 받는 사람 ${receiver}, 금액 ${amount}`} className="transfer-row" key={`${transfer.currency}:${transfer.senderId}:${transfer.receiverId}`}>
              <span className={`transfer-person${transfer.senderId === account.id ? ' transfer-me' : ''}`}><ParticipantAvatar profileImageUrl={profileOf(transfer.senderId)} /><small>보내는 사람</small><strong>{sender}{transfer.senderId === account.id ? ' (나)' : ''}</strong></span>
              <span className="transfer-direction"><AnimatedMoney amountMinor={transfer.amountMinor} announce={false} className="money transfer-money" currency={transfer.currency} key={`${data.id}:${transfer.currency}:${transfer.senderId}:${transfer.receiverId}`} prefix={finalized ? '' : '예상 '} /><span aria-hidden="true"><span className="transfer-line" /><ArrowRight size={18} /></span><small>보낼 예정</small></span>
              <span className={`transfer-person${transfer.receiverId === account.id ? ' transfer-me' : ''}`}><ParticipantAvatar profileImageUrl={profileOf(transfer.receiverId)} /><small>받는 사람</small><strong>{receiver}{transfer.receiverId === account.id ? ' (나)' : ''}</strong></span>
            </li>
          })}</ul><CurrencyDivider currency={total.currency} /></div>)}</div>}
        </div>
      </section>
      <BottomSheet closeLabel="제외 팝업 닫기" dialogRef={exclusionDialog} id="participant-exclusion-dialog" onClose={() => setCheck(null)} subtitle="참여자 제외" title={check ? nameOf(check.userId) : '참여자 제외'} titleId="exclusion-dialog-heading">
        {check && <>
          <div className={`notice${check.allowed ? '' : ' notice-warning'}`} role="status">{!check.allowed && <p>{check.expenses.length ? '해당 사용자와 연관된 정산이 있습니다.' : exclusionReason[check.reason ?? ''] ?? '현재 이 참여자를 제외할 수 없어요.'}</p>}
            {check.expenses.length > 0 && <><p>아래 내역을 작성자 또는 회차 생성자가 수정한 뒤 다시 제외해 주세요.</p><ul className="exclusion-issues">{check.expenses.map(expense => <li key={expense.id}>{data.expenses.some(item => item.id === expense.id) ? <a href={`#expense-${expense.id}`} onClick={event => { event.preventDefault(); revealExpense(expense.id) }}><strong>{expense.description}</strong></a> : <strong>{expense.description}</strong>}<span>{formatMoney(expense.amountMinor, expense.currency)} · 작성 {expense.authorName}</span><b>제외 전 수정 필요</b><small>{exclusionReason[expense.reason] ?? '결제·부담 관계를 먼저 수정해 주세요.'}</small></li>)}</ul><p className="help-text">목록에 안 보이는 지출은 아래 ‘지출 더 보기’로 확인할 수 있어요.</p></>}
            {check.allowed && (recording ? <><p>이 회차에서 제외할 수 있어요. 모임 참여 상태와 다른 회차는 유지돼요.</p><button className="secondary-button" disabled={action.busy} onClick={() => void exclude()} type="button">이 사용자 제외하기</button></> : <p>회차 생성자가 ‘기록 단계로 다시 열기’를 누른 다음 다시 제외해 주세요.</p>)}
          </div>
          <ErrorNotice error={action.error} retry={action.error instanceof ApiError && action.error.code === 'stale_round' ? () => void refresh() : undefined} />
        </>}
      </BottomSheet>
      <div className="row-between expense-heading" id="expense-section-heading"><h2 className="section-heading">지출 내역</h2><div className="inline-actions">{recording && myself && !myself.excludedAt && !editing && <button className="text-button" onClick={() => { setExpensesOpen(true); setEditing('new') }} type="button"><Plus size={17} /> 지출 추가</button>}<button aria-controls="round-expenses" aria-expanded={expensesOpen} aria-label={expensesOpen ? '모든 지출 내역 숨기기' : '모든 지출 내역 펼치기'} className="text-button expense-toggle" onClick={() => setExpensesOpen(open => !open)} title={expensesOpen ? '모든 지출 내역 숨기기' : '모든 지출 내역 펼치기'} type="button"><ChevronDown aria-hidden="true" className={expensesOpen ? 'expense-toggle-open' : undefined} size={24} /></button></div></div>
      <div className="stack" hidden={!expensesOpen} id="round-expenses">
        {editing && <ExpenseForm key={editing === 'new' ? 'new' : editing.id} round={data} expense={editing === 'new' ? null : editing} reload={refresh} saving={Boolean(savedExpense)} onSaved={setSavedExpense} onCancel={closeEditor} />}
        {data.expenses.length === 0 && <p className="empty-card">지출 내역이 없습니다. 지출을 기록한 뒤 정산을 확정해 주세요.</p>}
        {orderedExpenses.map((expense, index) => {
          const day = expenseDay(expense.createdAt), previousDay = index ? expenseDay(orderedExpenses[index - 1].createdAt).dateTime : null
          return <Fragment key={expense.id}>{day.dateTime !== previousDay && <div className="expense-day-divider"><time dateTime={day.dateTime}>{day.label}</time></div>}<ExpenseCard expense={expense} round={data} canEdit={Boolean(recording && (data.isCreator || expense.authorId === account.id && myself && !myself.excludedAt))} highlighted={check?.expenses.some(issue => issue.id === expense.id) ?? false} edit={() => setEditing(expense)} reload={refresh} /></Fragment>
        })}
        <ErrorNotice error={more.error} retry={() => void refresh()} />
        {data.expensesNextCursor && <button className="secondary-button" disabled={more.busy} onClick={() => void loadMore()} type="button">{more.busy ? '불러오는 중…' : '지출 더 보기'}</button>}
      </div>
      <ErrorNotice error={action.error} retry={action.error instanceof ApiError && action.error.code === 'stale_round' ? () => void refresh() : undefined} />
      {data.isCreator && recording && <div className="stack"><button className="primary-button" disabled={action.busy || Boolean(editing)} onClick={() => void command('confirm')} type="button">{action.busy ? '처리 중…' : '정산 확정'}</button><button className="secondary-button danger-outline-button" disabled={action.busy} onClick={() => void cancel()} type="button">회차 전체 취소</button></div>}
      {data.isCreator && data.status === 'CONFIRMED' && <div className="stack"><button className="primary-button" disabled={action.busy} onClick={() => void command('send')} type="button">전송 안내 확인</button><button className="secondary-button" disabled={action.busy} onClick={() => void command('reopen')} type="button">기록 단계로 다시 열기</button></div>}
    </div>}
  </>
}
