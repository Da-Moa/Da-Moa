'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ApiError, apiRequest, discardBankAccountRequests } from '../../lib/api-client'
import { BankFields, BankSaveMode, bankValues, ErrorNotice, Loading, OpenBankingConnection, openBankingCallbackError, type Account, useAction, useBankForm, useResource } from '../home/ui'

export default function OnboardingClient() {
  const me = useResource<Account>('/api/me')
  const account = me.data
  useEffect(() => {
    if (account?.purpose === 'app' && account.onboardingCompletedAt && !account.deletedAt) window.location.replace('/home')
  }, [account])
  return <main className="app-shell onboarding-page"><Link className="brand" href="/" aria-label="다모아 홈"><img alt="다모아" height="38" src="/logo/da-moa-trans.png" width="46" /></Link>
    <section className="tab-heading"><p>{account?.displayName ?? '다모아에 오신 것을 환영해요'}</p><h1>{account?.deletedAt ? '다시 만나 반가워요' : '정산받을 계좌를 등록해요'}</h1></section>
    <ErrorNotice error={me.error} retry={() => void me.reload()} />
    {!account ? me.loading && <Loading /> : <OnboardingForm account={account} reload={me.reload} />}
  </main>
}

function OnboardingForm({ account, reload }: { account: Account; reload: () => Promise<Account | null> }) {
  const action = useAction()
  const bankForm = useBankForm('/api/me/onboarding')
  const [draftVersion, setDraftVersion] = useState(account.bankVersion)
  const [formKey, setFormKey] = useState(0)
  const [bankReady, setBankReady] = useState(false)
  const [verify, setVerify] = useState(false)
  const [callbackError, setCallbackError] = useState<Error | null>(null)
  const connected = account.openBanking.status === 'CONNECTED'
  useEffect(() => {
    const url = new URL(window.location.href)
    if (!url.searchParams.has('openbanking_error') && !url.searchParams.has('verify')) return
    setVerify(url.searchParams.get('verify') === '1')
    setCallbackError(openBankingCallbackError(url.searchParams.get('openbanking_error')))
    if (url.searchParams.has('openbanking_error') || url.searchParams.has('verify')) {
      url.searchParams.delete('openbanking_error')
      url.searchParams.delete('verify')
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
    }
  }, [])
  function changeMode(value: boolean) {
    bankForm.clear(); setBankReady(false); setFormKey(key => key + 1); setVerify(value); action.setError(null); setCallbackError(null)
  }
  async function reloadLatest() {
    bankForm.clear()
    const latest = await reload()
    if (latest) { setDraftVersion(latest.bankVersion); setFormKey(key => key + 1); action.setError(null); setCallbackError(null) }
  }
  async function connect() {
    bankForm.clear(); setCallbackError(null)
    const result = await action.run(() => apiRequest<{ authorizationUrl?: string; returnTo?: string }>('/api/me/openbanking', { method: 'POST', body: { context: 'onboarding', returnTo: new URLSearchParams(window.location.search).get('returnTo') ?? '/home' } }))
    if (result?.authorizationUrl) window.location.assign(result.authorizationUrl)
    else if (result) await reloadLatest()
  }
  async function register(form: HTMLFormElement) {
    if (!bankReady) return
    const result = await action.run(async () => {
      try { return await apiRequest<{ id: string; returnTo: string }>('/api/me/onboarding', { method: 'POST', body: { ...bankValues(form, verify), expectedBankVersion: draftVersion, confirmRejoin: Boolean(account.deletedAt) }, signal: bankForm.signal() }) }
      catch (error) {
        if (error instanceof ApiError && ['openbanking_required', 'openbanking_reauth_required', 'openbanking_disconnect_pending'].includes(error.code)) { bankForm.clear(); await reload() }
        throw error
      }
    })
    if (result) { bankForm.clear(); window.location.replace(result.returnTo) }
  }
  async function logout() {
    bankForm.clear(); discardBankAccountRequests()
    const result = await action.run(() => apiRequest('/api/auth/logout', { method: 'POST' }))
    if (result) window.location.replace('/login')
  }
  return <section className="domain-card stack">
      {account.deletedAt && <p className="notice">같은 회원으로 재가입해 과거 정산을 볼 수 있어요. 이전 모임으로 자동 복귀하지 않으며 새 초대가 필요해요. 이전에 생성한 모임의 관리 권한은 복구되지 않아요.</p>}
      <BankSaveMode verify={verify} disabled={action.busy} onChange={changeMode} />
      {verify && <><ErrorNotice error={callbackError} /><OpenBankingConnection account={account} busy={action.busy} connect={() => void connect()} reload={() => void reloadLatest()} /></>}
      {(!verify || connected) && <form aria-busy={action.busy} autoComplete="off" className="stack" ref={bankForm.form} onSubmit={event => { event.preventDefault(); void register(event.currentTarget) }}>
        <BankFields key={`${formKey}-${verify}`} disabled={action.busy} error={action.error} onReadyChange={setBankReady} onAccountChange={bankForm.clear} onConnectionChange={reload} environment={account.openBanking.environment} verifyWithOpenBanking={verify} />
        <p className="help-text">{verify ? '계좌실명조회와 예금주 확인 후 가입을 완료해요.' : '입력한 계좌를 확인 전 상태로 저장하고 가입을 완료해요.'} 가입 후에도 대표 계좌를 바꿀 수 있어요.</p>
        {account.deletedAt && <label className="check-row"><input disabled={action.busy} type="checkbox" required /><span>안내를 확인했으며 기존 계정으로 재가입할게요.</span></label>}
        <button className="primary-button" disabled={action.busy || !bankReady} type="submit">{action.busy ? verify ? '계좌 확인 중…' : '계좌 저장 중…' : verify ? account.deletedAt ? '계좌 확인하고 재가입' : '계좌 확인하고 시작하기' : account.deletedAt ? '계좌 저장하고 재가입' : '계좌 저장하고 시작하기'}</button>
        <button className="text-button" disabled={action.busy} onClick={() => void reloadLatest()} type="button">입력 지우고 다시 확인</button>
      </form>}
      <ErrorNotice error={action.error} retry={action.error instanceof ApiError && action.error.code === 'bank_account_conflict' ? () => void reloadLatest() : undefined} />
      <button className="text-button" disabled={action.busy} onClick={() => void logout()} type="button">다른 카카오 계정으로 로그인</button>
    </section>
}
