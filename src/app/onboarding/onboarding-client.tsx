'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { apiRequest } from '../../lib/api-client'
import { BankFields, bankValues, ErrorNotice, Loading, type Account, useAction, useResource } from '../home/ui'

export default function OnboardingClient() {
  const me = useResource<Account>('/api/me')
  const action = useAction()
  const account = me.data
  useEffect(() => {
    if (account?.purpose === 'app' && account.onboardingCompletedAt && !account.deletedAt) window.location.replace('/home')
  }, [account])
  async function register(form: HTMLFormElement) {
    const result = await action.run(() => apiRequest<{ id: string; returnTo: string }>('/api/me/onboarding', { method: 'POST', body: { ...bankValues(form), confirmRejoin: Boolean(account?.deletedAt) } }))
    if (result) window.location.replace(result.returnTo)
  }
  async function logout() {
    const result = await action.run(() => apiRequest('/api/auth/logout', { method: 'POST' }))
    if (result) window.location.replace('/login')
  }
  return <main className="app-shell onboarding-page"><Link className="brand" href="/" aria-label="다모아 홈"><img alt="다모아" height="38" src="/logo/da-moa-trans.png" width="46" /></Link>
    <section className="tab-heading"><p>{account?.displayName ?? '다모아에 오신 것을 환영해요'}</p><h1>{account?.deletedAt ? '다시 만나 반가워요' : '정산받을 계좌를 등록해요'}</h1></section>
    <ErrorNotice error={me.error} retry={() => void me.reload()} />
    {!account ? me.loading && <Loading /> : <form className="domain-card stack" onSubmit={event => { event.preventDefault(); void register(event.currentTarget) }}>
      {account.deletedAt && <p className="notice">같은 회원으로 재가입해 과거 정산을 볼 수 있어요. 이전 모임으로 자동 복귀하지 않으며 새 초대가 필요해요. 이전에 생성한 모임의 관리 권한은 복구되지 않아요.</p>}
      <BankFields initial={account.bankAccount} />
      <p className="help-text">실제로 사용할 계좌를 확인해 주세요. 현재 계좌 진위·예금주 확인과 실제 송금은 제공하지 않아요. 가입 후 언제든 수정할 수 있어요.</p>
      {account.deletedAt && <label className="check-row"><input type="checkbox" required /><span>안내를 확인했으며 기존 계정으로 재가입할게요.</span></label>}
      <ErrorNotice error={action.error} />
      <button className="primary-button" disabled={action.busy} type="submit">{action.busy ? '처리 중…' : account.deletedAt ? '재가입 완료' : '계좌 등록하고 시작하기'}</button>
      <button className="text-button" disabled={action.busy} onClick={() => void logout()} type="button">다른 카카오 계정으로 로그인</button>
    </form>}
  </main>
}
