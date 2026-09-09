'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowRight, ChevronDown, ImagePlus, Pencil, Plus, Trash2, X } from 'lucide-react'
import { ApiError, apiRequest } from '../../lib/api-client'
import type { ExclusionCheck, Expense, MutationResult, Receipt, RoundDetail } from '../../lib/domain-types'
import { formatMoney } from '../../lib/money'
import { ErrorNotice, Loading, StatusBadge, useAccount, useAction, useResource } from './ui'

function ExpenseForm({ round, expense, onSaved, onCancel, reload }: { round: RoundDetail; expense: Expense | null; onSaved: () => Promise<unknown>; onCancel: () => void; reload: () => Promise<unknown> }) {
  const { account } = useAccount()
  const action = useAction()
  const expectedVersion = useRef(round.version)
  const [mode, setMode] = useState<'ALL' | 'SELECTED'>(expense?.splitMode ?? 'ALL')
  const [participants, setParticipants] = useState(expense?.participantIds ?? [])
  const minor = expense?.amountMinor ?? ''
  const amount = minor && round.currency === 'USD' ? `${minor.padStart(3, '0').slice(0, -2)}.${minor.padStart(3, '0').slice(-2)}` : minor
  async function save(form: HTMLFormElement) {
    const values = new FormData(form)
    const body = {
      description: String(values.get('description') ?? ''), amount: String(values.get('amount') ?? ''), payerId: String(values.get('payerId') ?? ''), splitMode: mode,
      ...(mode === 'SELECTED' ? { participantIds: values.getAll('participantIds').map(String) } : {}), expectedVersion: expectedVersion.current,
    }
    const result = await action.run(() => apiRequest<MutationResult>(`/api/rounds/${round.id}/expenses${expense ? `/${expense.id}` : ''}`, { method: expense ? 'PATCH' : 'POST', body }))
    if (result) await onSaved()
  }
  return <form className="domain-card expense-form stack" onSubmit={event => { event.preventDefault(); void save(event.currentTarget) }}>
    <h2>{expense ? '지출 수정' : '지출 기록'}</h2>
    <label className="field"><span>지출 내용</span><input autoFocus defaultValue={expense?.description ?? ''} name="description" maxLength={200} placeholder="예: 저녁 식사" required /></label>
    <label className="field"><span>총 금액 ({round.currency})</span><input defaultValue={amount} name="amount" inputMode={round.currency === 'USD' ? 'decimal' : 'numeric'} type="text" pattern={round.currency === 'USD' ? '[0-9]+([.][0-9]{1,2})?' : '[0-9]+'} placeholder={round.currency === 'USD' ? '0.00' : '0'} required /><small>기호·쉼표 없이 입력해 주세요. 환불과 음수 기록은 지원하지 않아요.</small></label>
    <label className="field"><span>실제로 결제한 사람</span><select defaultValue={expense?.payerId ?? account.id} name="payerId" required>{round.members.filter(member => !member.excludedAt || member.userId === expense?.payerId).map(member => <option key={member.userId} value={member.userId}>{member.displayName}{member.excludedAt ? ' (제외됨 · 기존 결제 유지)' : ''}</option>)}</select></label>
    <fieldset className="member-picker"><legend>부담할 사람</legend>
      <label className="check-row"><input type="radio" name="splitMode" value="ALL" checked={mode === 'ALL'} onChange={() => setMode('ALL')} /><span>전체 참여자 균등 분배</span></label>
      <label className="check-row"><input type="radio" name="splitMode" value="SELECTED" checked={mode === 'SELECTED'} onChange={() => setMode('SELECTED')} /><span>특정 사용자 균등 분배</span></label>
      {mode === 'SELECTED' && <div className="selected-members">{round.members.filter(member => !member.excludedAt).map(member => <label className="check-row" key={member.userId}><input checked={participants.includes(member.userId)} onChange={event => setParticipants(current => event.target.checked ? [...current, member.userId] : current.filter(id => id !== member.userId))} name="participantIds" type="checkbox" value={member.userId} /><span>{member.displayName}</span></label>)}</div>}
    </fieldset>
    <p className="help-text">결제자도 부담자에 포함될 수 있어요. 본인 몫을 제외한 금액을 받아요. 영수증은 저장한 지출에 증빙으로 올릴 수 있어요.</p>
    {round.status !== 'RECORDING' && <p className="notice notice-warning">다른 변경으로 기록 단계가 끝났어요. 입력을 확인한 뒤 창을 닫고 최신 상태를 확인해 주세요.</p>}
    <ErrorNotice error={action.error} retry={action.error instanceof ApiError && action.error.code === 'stale_round' ? () => void reload() : undefined} />
    <div className="quick-actions"><button className="primary-button" disabled={action.busy || round.status !== 'RECORDING'} type="submit">{action.busy ? '저장 중…' : '지출 저장'}</button><button className="secondary-button" disabled={action.busy} type="button" onClick={onCancel}>닫기</button></div>
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
    <div className="row-between"><button className="text-button" disabled={action.busy} onClick={() => url ? setUrl(null) : void view()} type="button">{url ? '증빙 접기' : `증빙 ${index + 1} 보기`}</button>{canEdit && <button aria-label={`증빙 ${index + 1} 삭제`} className="icon-button danger-text" disabled={busy} onClick={remove} type="button"><Trash2 size={17} /></button>}</div>
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
  const name = (id: string) => round.members.find(member => member.userId === id)?.displayName ?? '과거 참여자'
  async function remove() {
    if (!window.confirm('이 지출과 첨부한 증빙을 삭제할까요?')) return
    const result = await action.run(() => apiRequest(`/api/rounds/${round.id}/expenses/${expense.id}`, { method: 'DELETE', body: { expectedVersion: round.version } }))
    if (result) await reload()
  }
  async function upload() {
    if (!file) return
    if (file.type && !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { uploadAction.setError(new Error('JPEG·PNG·WebP 이미지만 올릴 수 있어요.')); return }
    const form = new FormData(); form.set('file', file); form.set('expectedVersion', String(round.version))
    const result = await uploadAction.run(() => apiRequest(`/api/rounds/${round.id}/expenses/${expense.id}/receipts`, { method: 'POST', body: form }))
    if (result) { uploadDialog.current?.close(); await reload() }
  }
  async function removeReceipt(id: string) {
    if (!window.confirm('이 증빙 이미지를 삭제할까요? 지출 기록은 유지돼요.')) return
    const result = await action.run(() => apiRequest(`/api/rounds/${round.id}/expenses/${expense.id}/receipts/${id}`, { method: 'DELETE', body: { expectedVersion: round.version } }))
    if (result) await reload()
  }
  return <article id={`expense-${expense.id}`} tabIndex={-1} className={`domain-card expense-card stack${highlighted ? ' expense-highlight' : ''}`}>
    {highlighted && <p className="highlight-label">제외 전 수정 필요</p>}
    <div className="row-between"><h3>{expense.description}</h3><strong className="money">{formatMoney(expense.amountMinor, round.currency)}</strong></div>
    <p className="help-text">결제 {name(expense.payerId)}</p>
    <div><span className="subtle-tag expense-split-tag">{expense.splitMode === 'ALL' ? '전체 균등 분배' : '특정 사용자 균등 분배'}</span><p className="burden-members">{expense.participantIds.map(name).join(', ')}</p></div>
    {expense.shares.some(share => share.amountMinor !== null) && <details><summary>최종 부담액 보기</summary><ul className="member-list">{expense.shares.map(share => <li key={share.userId}><span>{name(share.userId)}{share.receivedRemainder && <small className="subtle-tag">나머지 부담</small>}</span><strong className="money">{formatMoney(share.amountMinor ?? '0', round.currency)}</strong></li>)}</ul></details>}
    {canEdit && <div className="inline-actions"><button className="text-button" disabled={action.busy} onClick={edit} type="button"><Pencil size={15} /> 수정</button><button className="text-button danger-text" disabled={action.busy} onClick={() => void remove()} type="button"><Trash2 size={15} /> 삭제</button><button aria-controls={`receipt-upload-${expense.id}`} aria-haspopup="dialog" className="text-button" disabled={action.busy} onClick={() => uploadDialog.current?.showModal()} type="button"><ImagePlus size={15} /> 증빙 추가</button></div>}
    {expense.receipts.map((receipt, index) => <ReceiptImage key={receipt.id} receipt={receipt} index={index} canEdit={canEdit} busy={action.busy} remove={() => void removeReceipt(receipt.id)} />)}
    {canEdit && <dialog aria-labelledby={`receipt-upload-heading-${expense.id}`} className="account-dialog" id={`receipt-upload-${expense.id}`} ref={uploadDialog} onCancel={event => { if (uploadAction.busy) event.preventDefault() }} onClick={event => { if (event.target === event.currentTarget && !uploadAction.busy) event.currentTarget.close() }} onClose={() => { setFile(null); uploadAction.setError(null); if (input.current) input.current.value = '' }}>
      <div className="account-dialog-content stack"><div className="account-dialog-header"><div><p>지출 증빙</p><h2 id={`receipt-upload-heading-${expense.id}`}>증빙 이미지 추가</h2></div><button aria-label="증빙 이미지 추가 팝업 닫기" className="icon-button account-dialog-close" disabled={uploadAction.busy} onClick={() => uploadDialog.current?.close()} type="button"><X size={20} /></button></div>
        <label className="field"><span>이미지 파일</span><input accept="image/jpeg,image/png,image/webp" onChange={event => { setFile(event.target.files?.[0] ?? null); uploadAction.setError(null) }} ref={input} type="file" /></label>
        <p className="help-text">사용 가능한 타입: JPEG, PNG, WebP</p>
        <button className="primary-button" disabled={!file || uploadAction.busy} onClick={() => void upload()} type="button">{uploadAction.busy ? '업로드 중…' : '선택한 증빙 업로드'}</button>
        <ErrorNotice error={uploadAction.error} retry={uploadAction.error instanceof ApiError && uploadAction.error.code === 'stale_round' ? () => void reload() : undefined} />
      </div>
    </dialog>}
    <ErrorNotice error={action.error} retry={action.error instanceof ApiError && action.error.code === 'stale_round' ? () => void reload() : undefined} />
  </article>
}

const exclusionReason: Record<string, string> = {
  round_creator_cannot_leave: '회차 생성자는 제외할 수 없어요.', already_excluded: '이미 제외된 참여자예요.',
  invalid_round_state: '기록 단계 또는 전송 전 확정 단계에서만 제외를 검토할 수 있어요.',
  minimum_participants: '회차는 회차 생성자를 포함해 최소 2명이 필요해요.',
  payer_and_participant: '이 사람이 결제자이면서 부담자예요. 해당 관계를 먼저 수정해 주세요.',
  selected_participant: '특정 사용자 분배의 부담자예요. 해당 기록을 먼저 수정해 주세요.',
}

function ParticipantAvatar({ name }: { name: string }) {
  const label = name.trim().split(/\s+/).at(-1) ?? name
  return <span aria-hidden="true" className="participant-avatar">{Array.from(label)[0] ?? '?'}</span>
}

export default function RoundClient({ roundId }: { roundId: string }) {
  const router = useRouter()
  const { account } = useAccount()
  const resource = useResource<RoundDetail>(`/api/rounds/${roundId}`)
  const action = useAction()
  const more = useAction()
  const [editing, setEditing] = useState<Expense | 'new' | null>(null)
  const [expensesOpen, setExpensesOpen] = useState(true)
  const [check, setCheck] = useState<(ExclusionCheck & { userId: string }) | null>(null)
  const exclusionDialog = useRef<HTMLDialogElement>(null)
  const data = resource.data
  const myself = data?.members.find(member => member.userId === account.id)
  const recording = data?.status === 'RECORDING'
  useEffect(() => {
    if (check && !exclusionDialog.current?.open) exclusionDialog.current?.showModal()
  }, [check])
  async function refresh() {
    const updated = await resource.reload()
    return updated
  }
  async function command(name: string) {
    if (!data) return
    if (name === 'send' && !window.confirm('이대로 사용자들에게 메시지를 전송할까요?\n전송하면 기록이 잠기며 다음 화면에서 링크를 복사해 직접 공유합니다.')) return
    const result = await action.run(() => apiRequest<MutationResult>(`/api/rounds/${roundId}/${name}`, { method: 'POST', body: { expectedVersion: data.version } }))
    if (result) { setCheck(null); if (name === 'send') router.push(`/settlements/${roundId}`); else await refresh() }
  }
  async function cancel() {
    if (!data || !window.confirm('회차와 모든 지출·증빙을 영구 삭제할까요? 이 작업은 되돌릴 수 없어요.')) return
    const result = await action.run(() => apiRequest(`/api/rounds/${roundId}`, { method: 'DELETE', body: { expectedVersion: data.version } }))
    if (result) router.push(`/home/groups/${data.groupId}`)
  }
  async function loadMore() {
    if (!data?.expensesNextCursor) return
    const page = await more.run(() => apiRequest<RoundDetail>(`/api/rounds/${roundId}?cursor=${encodeURIComponent(data.expensesNextCursor!)}`))
    if (page) {
      if (page.version !== data.version) { more.setError(new Error('회차가 변경됐어요. 최신 내역을 새로 불러와 주세요.')); return }
      resource.setData(current => current ? { ...current, expenses: [...current.expenses, ...page.expenses.filter(expense => !current.expenses.some(existing => existing.id === expense.id))], expensesNextCursor: page.expensesNextCursor } : page)
    }
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
        exclusionDialog.current?.close(); setCheck(null); await refresh()
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
  const finalized = Boolean(data && data.finalizedAt !== null)
  const hasExpenses = Boolean(data && data.totalMinor !== '0')
  return <>
    <Link className="back-link" href={data ? `/home/groups/${data.groupId}` : '/home/groups'}>← 모임으로 돌아가기</Link>
    <ErrorNotice error={resource.error} retry={() => void refresh()} />
    {!data ? resource.loading && <Loading /> : <div className="stack">
      <section className="tab-heading compact"><p>{data.groupName}</p><h1>{data.name}</h1><div className="heading-status"><StatusBadge status={data.status} /><button className="text-button" disabled={resource.loading} onClick={() => void refresh()} type="button">새로고침</button></div></section>
      {data.status === 'CONFIRMED' && <p className="notice">지출을 확정했어요. 수정하려면 회차 생성자가 기록 단계를 다시 열어 주세요. 전송 후에는 수정할 수 없어요.</p>}
      <section className="domain-card"><div className="row-between"><span>전체 지출</span><strong className="large-money">{formatMoney(data.totalMinor, data.currency)}</strong></div><p className="help-text">{data.memberCount}명 참여 · {data.currency}</p></section>
      {(data.status === 'LOCKED' || data.status === 'COMPLETED') && <div className="notice"><p>{data.status === 'COMPLETED' ? '종료된 회차예요. 모든 정산 기록은 읽기 전용이에요.' : data.finalizedAt ? '기록이 잠겼어요. 본인의 최종 정산 안내를 확인해 주세요.' : '기록이 잠겼어요. 회차 생성자가 나머지를 한 번 추첨하면 최종 금액을 확인할 수 있어요.'}</p><Link className="primary-button" href={`/settlements/${roundId}`} prefetch={false}>내 정산 안내 보기</Link></div>}
      <section className="domain-card stack participant-section"><div><h2>회차 참여자</h2><p className="help-text">참여자와 나의 현재 송금 흐름을 한눈에 확인하세요.</p></div>
        <ul aria-label="회차 참여자" className="participant-grid">{data.members.map(member => {
          const canExclude = data.isCreator && member.excludedAt === null && member.userId !== data.creatorId && ['RECORDING', 'CONFIRMED'].includes(data.status)
          const card = <><ParticipantAvatar name={member.displayName} /><span className="participant-name"><strong>{member.displayName}{member.userId === account.id ? ' (나)' : ''}</strong><span>{member.userId === data.creatorId && <small className="subtle-tag">회차 생성자</small>}{member.excludedAt !== null && <small className="subtle-tag">제외됨 · 기록 보존</small>}</span></span></>
          return <li key={member.userId}>{canExclude ? <button aria-controls="participant-exclusion-dialog" aria-haspopup="dialog" aria-label={`${member.displayName} 제외`} className="participant-card" disabled={action.busy} onClick={() => void checkExclusion(member.userId)} type="button">{card}</button> : <div className={`participant-card${member.excludedAt !== null ? ' participant-excluded' : ''}`}>{card}</div>}</li>
        })}</ul>
        <div className="settlement-flow stack"><div className="row-between"><h3>나의 송금 관계</h3>{hasExpenses && <small className="subtle-tag">{finalized ? '최종' : '현재 예상'} {data.transfers.length}건</small>}</div>
          {data.transfers.length === 0 ? <p className="flow-empty" role="status">{!hasExpenses ? '지출을 기록하면 나의 예상 송금 관계를 표시해요.' : finalized ? '내가 주고받을 금액이 없어요.' : '현재 기록 기준으로 내가 주고받을 금액이 없어요.'}</p> : <ul aria-label={finalized ? '나의 최종 송금 관계' : '나의 현재 예상 송금 관계'} aria-live="polite" className="transfer-list">{data.transfers.map(transfer => {
            const sender = nameOf(transfer.senderId), receiver = nameOf(transfer.receiverId), amount = formatMoney(transfer.amountMinor, data.currency)
            return <li aria-label={`${finalized ? '최종' : '예상'} 송금, 보내는 사람 ${sender}, 받는 사람 ${receiver}, 금액 ${amount}`} className="transfer-row" key={`${transfer.senderId}:${transfer.receiverId}`}>
              <span className="transfer-person"><ParticipantAvatar name={sender} /><small>보내는 사람</small><strong>{sender}{transfer.senderId === account.id ? ' (나)' : ''}</strong></span>
              <span className="transfer-direction"><strong className="money">{finalized ? amount : `예상 ${amount}`}</strong><span aria-hidden="true"><span className="transfer-line" /><ArrowRight size={18} /></span><small>{finalized ? '보내요' : '보낼 예정'}</small></span>
              <span className="transfer-person"><ParticipantAvatar name={receiver} /><small>받는 사람</small><strong>{receiver}{transfer.receiverId === account.id ? ' (나)' : ''}</strong></span>
            </li>
          })}</ul>}
          {!finalized && hasExpenses && <p className="help-text" role="status">지금까지 기록한 지출 내역을 기반으로 한 예상치예요</p>}
        </div>
      </section>
      <dialog aria-labelledby="exclusion-dialog-heading" className="account-dialog" id="participant-exclusion-dialog" ref={exclusionDialog} onCancel={() => setCheck(null)} onClick={event => { if (event.target === event.currentTarget) { event.currentTarget.close(); setCheck(null) } }}>
        {check && <div className="account-dialog-content stack"><div className="account-dialog-header"><div><p>참여자 제외</p><h2 id="exclusion-dialog-heading">{nameOf(check.userId)}</h2></div><button aria-label="제외 팝업 닫기" className="icon-button account-dialog-close" onClick={() => { exclusionDialog.current?.close(); setCheck(null) }} type="button"><X size={20} /></button></div>
          <div className={`notice${check.allowed ? '' : ' notice-warning'}`} role="status">{!check.allowed && <p>{check.expenses.length ? '해당 사용자와 연관된 정산이 있습니다.' : exclusionReason[check.reason ?? ''] ?? '현재 이 참여자를 제외할 수 없어요.'}</p>}
            {check.expenses.length > 0 && <><p>아래 내역을 작성자 또는 회차 생성자가 수정한 뒤 다시 제외해 주세요.</p><ul className="exclusion-issues">{check.expenses.map(expense => <li key={expense.id}>{data.expenses.some(item => item.id === expense.id) ? <a href={`#expense-${expense.id}`} onClick={event => { event.preventDefault(); revealExpense(expense.id) }}><strong>{expense.description}</strong></a> : <strong>{expense.description}</strong>}<span>{formatMoney(expense.amountMinor, data.currency)} · 작성 {expense.authorName}</span><b>제외 전 수정 필요</b><small>{exclusionReason[expense.reason] ?? '결제·부담 관계를 먼저 수정해 주세요.'}</small></li>)}</ul><p className="help-text">목록에 안 보이는 지출은 아래 ‘지출 더 보기’로 확인할 수 있어요.</p></>}
            {check.allowed && (recording ? <><p>이 회차에서 제외할 수 있어요. 모임 참여 상태와 다른 회차는 유지돼요.</p><button className="secondary-button" disabled={action.busy} onClick={() => void exclude()} type="button">이 사용자 제외하기</button></> : <p>회차 생성자가 ‘기록 단계로 다시 열기’를 누른 다음 다시 제외해 주세요.</p>)}
          </div>
          <ErrorNotice error={action.error} retry={action.error instanceof ApiError && action.error.code === 'stale_round' ? () => void refresh() : undefined} />
        </div>}
      </dialog>
      <div className="row-between expense-heading"><h2 className="section-heading">지출 내역</h2><div className="inline-actions">{recording && myself && !myself.excludedAt && !editing && <button className="text-button" onClick={() => { setExpensesOpen(true); setEditing('new') }} type="button"><Plus size={17} /> 지출 추가</button>}<button aria-controls="round-expenses" aria-expanded={expensesOpen} aria-label={expensesOpen ? '모든 지출 내역 숨기기' : '모든 지출 내역 펼치기'} className="text-button expense-toggle" onClick={() => setExpensesOpen(open => !open)} title={expensesOpen ? '모든 지출 내역 숨기기' : '모든 지출 내역 펼치기'} type="button"><ChevronDown aria-hidden="true" className={expensesOpen ? 'expense-toggle-open' : undefined} size={24} /></button></div></div>
      <div className="stack" hidden={!expensesOpen} id="round-expenses">
        {editing && <ExpenseForm key={editing === 'new' ? 'new' : editing.id} round={data} expense={editing === 'new' ? null : editing} reload={refresh} onSaved={async () => { setEditing(null); setCheck(null); await refresh() }} onCancel={() => setEditing(null)} />}
        {data.expenses.length === 0 && <p className="empty-card">지출 내역이 없습니다. 지출을 기록한 뒤 정산을 확정해 주세요.</p>}
        {data.expenses.map(expense => <ExpenseCard key={expense.id} expense={expense} round={data} canEdit={Boolean(recording && (data.isCreator || expense.authorId === account.id && myself && !myself.excludedAt))} highlighted={check?.expenses.some(issue => issue.id === expense.id) ?? false} edit={() => { setEditing(expense); window.scrollTo({ top: 0, behavior: 'smooth' }) }} reload={refresh} />)}
        <ErrorNotice error={more.error} retry={() => void refresh()} />
        {data.expensesNextCursor && <button className="secondary-button" disabled={more.busy} onClick={() => void loadMore()} type="button">{more.busy ? '불러오는 중…' : '지출 더 보기'}</button>}
      </div>
      <ErrorNotice error={action.error} retry={action.error instanceof ApiError && action.error.code === 'stale_round' ? () => void refresh() : undefined} />
      {data.isCreator && <section className="domain-card stack"><h2>회차 생성자 정산 관리</h2>
        {recording && <><button className="primary-button" disabled={action.busy || Boolean(editing)} onClick={() => void command('confirm')} type="button">{action.busy ? '처리 중…' : '정산 확정'}</button>{editing && <p className="help-text">작성 중인 지출을 저장하거나 닫은 뒤 확정해 주세요.</p>}<button className="text-button danger-text" disabled={action.busy} onClick={() => void cancel()} type="button">회차 전체 취소</button></>}
        {data.status === 'CONFIRMED' && <><button className="primary-button" disabled={action.busy} onClick={() => void command('send')} type="button">전송 안내 확인</button><button className="secondary-button" disabled={action.busy} onClick={() => void command('reopen')} type="button">기록 단계로 다시 열기</button></>}
        {data.status === 'LOCKED' && <Link className="primary-button" href={`/settlements/${roundId}`} prefetch={false}>{data.finalizedAt ? '정산 안내 · 종료하기' : '나머지 추첨하러 가기'}</Link>}
        {data.status === 'COMPLETED' && <p className="help-text">정산 종료 처리됐어요. 다시 열기·수정·삭제할 수 없어요.</p>}
      </section>}
    </div>}
  </>
}
