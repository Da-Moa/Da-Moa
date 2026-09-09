'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AnimatedMoney } from '../animated-money'
import { ApiError, apiRequest } from '../../lib/api-client'
import type { SettlementDTO } from '../../lib/domain-types'
import { formatMoney } from '../../lib/money'
import { CopyLink, ErrorNotice, Loading, ParticipantAvatar, StatusBadge, useAction, useResource } from '../home/ui'

export default function SettlementClient({ roundId }: { roundId: string }) {
  const router = useRouter()
  const settlement = useResource<SettlementDTO>(`/api/rounds/${roundId}/settlement`)
  const action = useAction()
  const data = settlement.data
  const reload = settlement.reload
  const balanceMinor = BigInt(data?.balanceMinor ?? '0')
  const receivedMinor = data?.incoming.reduce((sum, transfer) => transfer.receivedAt === null ? sum : sum + BigInt(transfer.amountMinor), 0n) ?? 0n
  const remainingIncomingMinor = -balanceMinor - receivedMinor
  const displayedBalanceMinor = balanceMinor < 0n ? remainingIncomingMinor > 0n ? remainingIncomingMinor : 0n : balanceMinor
  const allIncomingReceived = Boolean(data?.incoming.length && data.incoming.every(transfer => transfer.receivedAt !== null))
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') void reload() }
    window.addEventListener('focus', refresh)
    window.addEventListener('pageshow', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => { window.removeEventListener('focus', refresh); window.removeEventListener('pageshow', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [reload])
  async function command(name: 'draw' | 'complete' | 'force-complete') {
    if (!data) return
    if (name === 'complete' && !window.confirm('받을 내역이 모두 확인됐어요. 이 회차의 정산을 종료할까요? 종료 후 모든 정산 기록은 읽기 전용이며 참여자의 탈퇴 제한이 해제돼요.')) return
    if (name === 'force-complete' && !window.confirm(`아직 받을 내역을 모두 확인하지 않은 사람이 ${data.requiredCount - data.checkedCount}명 있어요. 확인을 기다리지 않고 강제로 정산을 종료할까요? 종료 후에는 되돌릴 수 없어요.`)) return
    const result = await action.run(() => apiRequest(`/api/rounds/${roundId}/${name}`, { method: 'POST', body: { expectedVersion: data.version } }))
    if (result && (name === 'complete' || name === 'force-complete')) router.push('/home/history')
    else await reload()
  }
  async function setChecked(checked: boolean, senderId?: string) {
    if (!data) return
    const result = await action.run(() => apiRequest(`/api/rounds/${roundId}/settlement-check`, { method: 'POST', body: { checked, expectedVersion: data.version, ...(senderId ? { senderId } : {}) } }))
    if (result) await reload()
  }
  return <>
    <Link className="back-link" href={`/home/rounds/${roundId}`}>← 지출 내역 보기</Link>
    <ErrorNotice error={settlement.error} retry={() => void reload()} />
    {!data ? settlement.loading && <Loading /> : <div className="stack">
      <section className="tab-heading compact"><p>{data.groupName}</p><h1>{data.name}</h1><div className="heading-status"><StatusBadge status={data.status} /><button className="text-button" disabled={settlement.loading} onClick={() => void reload()} type="button">{settlement.loading ? '확인 중…' : '최신 정보 새로고침'}</button></div></section>
      {!data.finalized ? <section className="domain-card stack"><h2>최종 금액을 준비하고 있어요</h2>{data.status === 'LOCKED' ? <><p>나누어떨어지지 않은 금액이 있어요. 회차 생성자가 한 번 추첨하면 최종 부담액과 보낼 금액이 정해져요.</p><p className="help-text">{data.currency === 'USD' ? '1센트' : data.currency === 'JPY' ? '1엔' : '1원'}씩 추가 부담할 사람을 지출별로 뽑아요. 결과는 한 번 저장되며 다시 뽑을 수 없어요.</p>{data.isCreator ? <button className="primary-button" disabled={action.busy} onClick={() => void command('draw')} type="button">{action.busy ? '결과 저장 중…' : '랜덤 돌리기'}</button> : <p className="notice">회차 생성자의 추첨을 기다려 주세요.</p>}</> : <p>아직 전송 전이에요. 회차 생성자가 정산을 확정하고 전송해야 최종 안내를 볼 수 있어요.</p>}</section> : <>
        <section className="domain-card settlement-summary"><p>{balanceMinor > 0n ? '내가 보낼 금액' : balanceMinor < 0n ? '내가 받을 금액' : '송금할 금액 없음'}</p><AnimatedMoney amountMinor={displayedBalanceMinor.toString()} currency={data.currency} key={`${roundId}-${data.currency}`} /><p className="help-text">본인의 최종 안내예요. 실제 송금은 직접 진행해 주세요.</p></section>
        {data.outgoing.length > 0 && <section className="stack"><h2 className="section-heading">이 사람에게 보내 주세요</h2>{data.outgoing.map(transfer => <article className="domain-card stack" key={transfer.receiverId}><div className="row-between"><div className="settlement-person"><ParticipantAvatar profileImageUrl={transfer.profileImageUrl} /><h3>{transfer.displayName}</h3></div><strong className="money">{formatMoney(transfer.amountMinor, data.currency)}</strong></div>
          {data.currency === 'KRW' && (settlement.error ? <p className="notice notice-warning">최신 계좌를 확인하지 못했어요. 새로고침한 뒤 확인해 주세요.</p> : transfer.account?.bankName && transfer.account.accountNumber && transfer.account.accountHolder ? <dl className="bank-details"><div><dt>은행</dt><dd>{transfer.account.bankName}</dd></div><div><dt>계좌번호</dt><dd className="account-number">{transfer.account.accountNumber}</dd></div><div><dt>예금주</dt><dd>{transfer.account.accountHolder}</dd></div></dl> : <p className="notice notice-warning">등록 계좌를 확인할 수 없어요. 상대방에게 계좌 수정을 요청한 뒤 새로고침해 주세요.</p>)}
        </article>)}</section>}
        {data.incoming.length > 0 && <section className="domain-card stack"><h2>이 사람에게 받아요</h2><ul className="member-list incoming-check-list">{data.incoming.map(transfer => {
          const received = transfer.receivedAt !== null
          const amount = formatMoney(transfer.amountMinor, data.currency)
          const actionLabel = data.status === 'COMPLETED' ? `${received ? '확인 완료' : '확인 대기'}, 읽기 전용` : received ? '정산 확인 해제' : '정산 확인'
          return <li key={transfer.senderId}><button aria-label={`${transfer.displayName}에게서 받을 ${amount} ${actionLabel}`} aria-pressed={received} className="settlement-receipt-toggle" disabled={action.busy || data.status === 'COMPLETED'} onClick={() => void setChecked(!received, transfer.senderId)} type="button"><span className="settlement-person"><ParticipantAvatar profileImageUrl={transfer.profileImageUrl} /><span className={received ? 'settlement-received-text' : undefined}>{transfer.displayName}</span></span><strong className={`money${received ? ' settlement-received-text' : ''}`}>{amount}</strong></button></li>
        })}</ul><label className="check-row settlement-check-all"><input checked={allIncomingReceived} disabled={action.busy || data.status === 'COMPLETED'} onChange={event => void setChecked(event.target.checked)} type="checkbox" /><span>모두 정산 확인{data.status === 'COMPLETED' ? ' (읽기 전용)' : ''}</span></label></section>}
        {balanceMinor === 0n && data.outgoing.length === 0 && data.incoming.length === 0 && <p className="notice">주고받을 금액이 없어요. 회차 종료는 회차 생성자가 별도로 처리해요.</p>}
        {data.currency !== 'KRW' && <p className="help-text">{data.currency} 정산은 상대방과 금액만 안내해요.</p>}
        {data.requiredCount > 0 && <><section aria-labelledby="settlement-check-progress-heading" className="settlement-check-progress">
          <div className="row-between"><h2 className="section-heading" id="settlement-check-progress-heading">정산 확인 현황</h2><strong aria-live="polite">{data.checkedCount}/{data.requiredCount}명 완료</strong></div>
          <progress aria-labelledby="settlement-check-progress-heading" max={data.requiredCount} value={data.checkedCount}>{data.checkedCount}/{data.requiredCount}</progress>
        </section>
        <section aria-labelledby="settlement-check-members-heading" className="domain-card stack"><h2 id="settlement-check-members-heading">받는 사람별 확인</h2><ul className="member-list settlement-check-members">{data.confirmations.map(member => <li key={member.userId}><span className="settlement-person"><ParticipantAvatar profileImageUrl={member.profileImageUrl} /><strong>{member.displayName}</strong></span><span className={`status-badge ${member.checkedAt === null ? 'state-locked' : 'state-completed'}`}>{member.checkedAt === null ? '대기' : '완료'}</span></li>)}</ul></section></>}
        {data.sharePath && <section className="domain-card stack"><h2>정산 안내 공유</h2><p className="help-text">링크를 통해 접속하면 자신이 보낼 금액과 계좌번호, 자신이 받을 금액을 볼 수 있어요.</p><CopyLink path={data.sharePath} label="정산 안내 링크 복사" /></section>}
        {data.isCreator && data.status === 'LOCKED' && <div className="stack"><button className="primary-button" disabled={action.busy || !data.allChecked} onClick={() => void command('complete')} type="button">정산 종료</button>{!data.allChecked && <button className="secondary-button danger-outline-button" disabled={action.busy} onClick={() => void command('force-complete')} type="button">강제 정산 종료</button>}</div>}
      </>}
      <ErrorNotice error={action.error} retry={action.error instanceof ApiError && action.error.code === 'stale_round' ? () => { action.setError(null); void reload() } : undefined} />
    </div>}
  </>
}
