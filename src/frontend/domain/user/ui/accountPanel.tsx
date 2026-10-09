'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ChevronLeft, CircleUserRound } from 'lucide-react'
import { ApiError, apiRequest, useAction } from '../../../global/util'
import { formatAccountNumber, type BankAccountResponseDTO } from '../../../../shared/domain/user'
import { useAccount } from '../hooks/accountContext'
import { discardBankAccountRequests } from '../requests'
import { BankFields, bankValues, useBankForm } from './bankFields'
import { ErrorNotice } from './errorNotice'

export function AccountPanel() {
  const { account, reloadAccount } = useAccount()
  const action = useAction()
  const bankForm = useBankForm('/api/me/bank-account')
  const [draftVersion, setDraftVersion] = useState(account.bankVersion)
  const [formKey, setFormKey] = useState(0)
  const ready = account.bankVersion >= draftVersion
  const [saved, setSaved] = useState(false)
  const [editingBank, setEditingBank] = useState(false)
  const bankToggle = useRef<HTMLButtonElement>(null)
  const [blockedRounds, setBlockedRounds] = useState<{ id: string; name: string; groupName?: string }[]>([])
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
    if (latest) { setDraftVersion(latest.bankVersion); setFormKey(key => key + 1); action.setError(null); setSaved(false) }
  }
  function cancelBankEdit() {
    bankForm.clear(); action.setError(null); setSaved(false); setEditingBank(false)
    bankToggle.current?.focus({ preventScroll: true })
  }
  async function save(form: HTMLFormElement) {
    if (!ready) return
    setSaved(false)
    const result = await action.run(() => apiRequest<BankAccountResponseDTO>('/api/me/bank-account', { method: 'PUT', body: { ...bankValues(form), expectedBankVersion: draftVersion }, signal: bankForm.signal() }))
    if (result) {
      setDraftVersion(result.bankVersion); setFormKey(key => key + 1)
      cancelBankEdit(); setSaved(true)
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
      <button aria-expanded={editingBank} className="secondary-button account-bank-toggle" disabled={action.busy || !ready} onClick={() => { if (editingBank) cancelBankEdit(); else { setDraftVersion(account.bankVersion); setEditingBank(true) } }} ref={bankToggle} type="button">{editingBank ? '계좌 수정 닫기' : !ready ? '저장된 계좌 확인 중…' : '계좌 수정하기'}</button>
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
