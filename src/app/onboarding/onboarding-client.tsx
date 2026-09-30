'use client'

import { useEffect, useState } from 'react'
import { ApiError, apiRequest, discardBankAccountRequests } from '../../lib/api-client'
import { BankFields, bankValues, ErrorNotice, Loading, type Account, useAction, useBankForm, useResource } from '../home/ui'

export default function OnboardingClient() {
  const me = useResource<Account>('/api/me')
  const account = me.data
  useEffect(() => {
    if (account?.purpose === 'app' && account.onboardingCompletedAt && !account.deletedAt) window.location.replace('/home')
  }, [account])
  return <main className="app-shell onboarding-page">
    <section className="tab-heading">{!account?.deletedAt && <p>{account?.displayName ?? '다모아에 오신 것을 환영해요'}</p>}<h1>{account?.deletedAt ? '다시 만나 반가워요' : '정산받을 계좌를 등록해요'}</h1></section>
    <ErrorNotice error={me.error} retry={() => void me.reload()} />
    {!account ? me.loading && <Loading /> : <OnboardingForm account={account} reload={me.reload} />}
  </main>
}

function OnboardingForm({ account, reload }: { account: Account; reload: () => Promise<Account | null> }) {
  const action = useAction()
  const bankForm = useBankForm('/api/me/onboarding')
  const [draftVersion, setDraftVersion] = useState(account.bankVersion)
  const [formKey, setFormKey] = useState(0)
  async function reloadLatest() {
    bankForm.clear()
    const latest = await reload()
    if (latest) { setDraftVersion(latest.bankVersion); setFormKey(key => key + 1); action.setError(null) }
  }
  async function register(form: HTMLFormElement) {
    const result = await action.run(() => apiRequest<{ id: string; returnTo: string }>('/api/me/onboarding', { method: 'POST', body: { ...bankValues(form), expectedBankVersion: draftVersion, confirmRejoin: Boolean(account.deletedAt) }, signal: bankForm.signal() }))
    if (result) { bankForm.clear(); window.location.replace(result.returnTo) }
  }
  async function logout() {
    bankForm.clear(); discardBankAccountRequests()
    const result = await action.run(() => apiRequest('/api/auth/logout', { method: 'POST' }))
    if (result) window.location.replace('/login')
  }
  function goBack() {
    bankForm.clear()
    if (window.history.length > 1) window.history.back()
    else window.location.replace('/login')
  }
  return <section className="domain-card stack">
      <form aria-busy={action.busy} autoComplete="off" className="stack" ref={bankForm.form} onSubmit={event => { event.preventDefault(); void register(event.currentTarget) }}>
        <BankFields key={formKey} disabled={action.busy} error={action.error} />
        <button className="primary-button" disabled={action.busy} type="submit">{action.busy ? '계좌 저장 중…' : account.deletedAt ? '재가입' : '계좌 저장하고 시작하기'}</button>
        {!account.deletedAt && <button className="text-button" disabled={action.busy} onClick={() => void reloadLatest()} type="button">입력 지우고 다시 확인</button>}
      </form>
      <ErrorNotice error={action.error} retry={action.error instanceof ApiError && action.error.code === 'bank_account_conflict' ? () => void reloadLatest() : undefined} />
      <button className="text-button" disabled={action.busy} onClick={() => void logout()} type="button">다른 카카오 계정으로 로그인</button>
      {account.deletedAt && <button className="text-button" disabled={action.busy} onClick={goBack} type="button">뒤로가기</button>}
    </section>
}
