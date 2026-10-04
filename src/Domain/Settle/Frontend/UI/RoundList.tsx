'use client'

import Link from 'next/link'
import { apiRequest, Loading, useAction, useResource } from '../../../../Global/Util/Frontend'
import { formatMoney } from '../../Shared'
import type { Page, RoundSummary } from '../../../../lib/domain-types'
import { StatusBadge } from './StatusBadge'
import { ErrorNotice } from './ErrorNotice'

export function RoundList({ endpoint, empty = '아직 정산 회차가 없어요.', onMore }: { endpoint: string; empty?: string; onMore?: () => void }) {
  const resource = useResource<Page<RoundSummary>>(endpoint)
  const more = useAction()
  async function loadMore() {
    if (!resource.data?.nextCursor) return
    const url = new URL(endpoint, window.location.origin)
    url.searchParams.set('cursor', resource.data.nextCursor)
    const page = await more.run(() => apiRequest<Page<RoundSummary>>(`${url.pathname}${url.search}`))
    if (page) resource.setData(current => current ? { items: [...current.items, ...page.items.filter(item => !current.items.some(existing => existing.id === item.id))], nextCursor: page.nextCursor } : page)
  }
  const cards = resource.data?.items.map(round => <Link className="domain-card round-link" key={round.id} href={`/home/rounds/${round.id}`}>
    <div className="row-between"><span className="eyebrow">{round.groupName}</span><StatusBadge status={round.status} /></div>
    <h2>{round.name}</h2><p className="help-text">{round.memberCount}명 · {new Date(round.createdAt * 1000).toLocaleDateString('ko-KR')} · {round.currency}</p>
    <div className="row-between"><span>{round.balanceMinor === null ? '최종 금액 대기' : BigInt(round.balanceMinor) > 0n ? '내가 보낼 금액' : BigInt(round.balanceMinor) < 0n ? '내가 받을 금액' : '송금할 금액 없음'}</span>
      <strong className="money">{round.balanceMinor === null ? formatMoney(round.totalMinor, round.currency) + ' 지출' : formatMoney(round.balanceMinor.replace('-', ''), round.currency)}</strong>
    </div>
  </Link>)
  return <div aria-label={onMore ? '내가 참여한 회차 요약' : undefined} className="stack">
    <ErrorNotice error={resource.error} retry={() => void resource.reload()} />
    {resource.loading && !resource.data && <Loading />}
    {resource.data?.items.length === 0 && <div className="empty-card"><p>{empty}</p><Link href="/home/groups">모임에서 회차 시작하기</Link></div>}
    {cards}
    {!onMore && <ErrorNotice error={more.error} retry={() => void loadMore()} />}
    {resource.data?.nextCursor && <button aria-controls={onMore ? 'group-rounds-dialog' : undefined} aria-haspopup={onMore ? 'dialog' : undefined} aria-label={onMore ? '참여 회차 전체 보기' : '회차 더보기'} className="secondary-button" disabled={!onMore && more.busy} onClick={onMore ?? (() => void loadMore())} type="button">{!onMore && more.busy ? '불러오는 중…' : '더보기'}</button>}
  </div>
}

