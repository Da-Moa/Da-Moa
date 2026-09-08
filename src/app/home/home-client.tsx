'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronRight, Plus, Users } from 'lucide-react'
import { apiRequest } from '../../lib/api-client'
import { formatMoney } from '../../lib/money'
import type { GroupSummary, MutationResult, Page, RoundSummary } from '../../lib/domain-types'
import type { HomeTab } from './authenticated-home'
import { AccountPanel, ErrorNotice, Loading, StatusBadge, useAccount, useAction, useResource } from './ui'

export function RoundList({ endpoint, empty = '아직 정산 회차가 없어요.' }: { endpoint: string; empty?: string }) {
  const resource = useResource<Page<RoundSummary>>(endpoint)
  const more = useAction()
  async function loadMore() {
    if (!resource.data?.nextCursor) return
    const page = await more.run(() => apiRequest<Page<RoundSummary>>(`${endpoint}${endpoint.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(resource.data!.nextCursor!)}`))
    if (page) resource.setData(current => current ? { items: [...current.items, ...page.items.filter(item => !current.items.some(existing => existing.id === item.id))], nextCursor: page.nextCursor } : page)
  }
  return <div className="stack">
    <ErrorNotice error={resource.error} retry={() => void resource.reload()} />
    {resource.loading && !resource.data && <Loading />}
    {resource.data?.items.length === 0 && <div className="empty-card"><p>{empty}</p><Link href="/home/groups">모임에서 회차 시작하기</Link></div>}
    {resource.data?.items.map(round => <Link className="domain-card round-link" key={round.id} href={`/home/rounds/${round.id}`}>
      <div className="row-between"><span className="eyebrow">{round.groupName}</span><StatusBadge status={round.status} /></div>
      <h2>{round.name}</h2><p className="help-text">{round.memberCount}명 · {new Date(round.createdAt * 1000).toLocaleDateString('ko-KR')} · {round.currency}</p>
      <div className="row-between"><span>{round.balanceMinor === null ? '최종 금액 대기' : BigInt(round.balanceMinor) > 0n ? '내가 보낼 금액' : BigInt(round.balanceMinor) < 0n ? '내가 받을 금액' : '송금할 금액 없음'}</span>
        <strong className="money">{round.balanceMinor === null ? formatMoney(round.totalMinor, round.currency) + ' 지출' : formatMoney(round.balanceMinor.replace('-', ''), round.currency)}</strong>
      </div>
    </Link>)}
    <ErrorNotice error={more.error} retry={() => void loadMore()} />
    {resource.data?.nextCursor && <button className="secondary-button" disabled={more.busy} onClick={() => void loadMore()} type="button">{more.busy ? '불러오는 중…' : '더 보기'}</button>}
  </div>
}

function GroupsList() {
  const router = useRouter()
  const groups = useResource<Page<GroupSummary>>('/api/groups')
  const action = useAction()
  const more = useAction()
  async function create(form: HTMLFormElement) {
    const values = new FormData(form)
    const result = await action.run(() => apiRequest<MutationResult>('/api/groups', { method: 'POST', body: { name: String(values.get('name') ?? '') } }))
    if (result) router.push(`/home/groups/${result.id}`)
  }
  async function loadMore() {
    if (!groups.data?.nextCursor) return
    const page = await more.run(() => apiRequest<Page<GroupSummary>>(`/api/groups?cursor=${encodeURIComponent(groups.data!.nextCursor!)}`))
    if (page) groups.setData(current => current ? { items: [...current.items, ...page.items], nextCursor: page.nextCursor } : page)
  }
  return <div className="stack">
    <ErrorNotice error={groups.error} retry={() => void groups.reload()} />
    {groups.loading && !groups.data && <Loading />}
    {groups.data?.items.length === 0 && <p className="empty-card">모임을 만들거나 초대 링크를 받아 참여해 주세요.</p>}
    {groups.data?.items.map(group => <Link className="domain-card group-link" key={group.id} href={`/home/groups/${group.id}`}><Users size={23} /><div><h2>{group.name}</h2></div><ChevronRight size={20} /></Link>)}
    <ErrorNotice error={more.error} retry={() => void loadMore()} />
    {groups.data?.nextCursor && <button className="secondary-button" disabled={more.busy} type="button" onClick={() => void loadMore()}>모임 더 보기</button>}
    <form className="domain-card stack" onSubmit={event => { event.preventDefault(); void create(event.currentTarget) }}>
      <h2>새 모임 만들기</h2>
      <label className="field"><span>모임 이름</span><input autoComplete="off" maxLength={100} name="name" placeholder="예: 주말 친구 모임" required /></label>
      <ErrorNotice error={action.error} />
      <button className="primary-button" disabled={action.busy} type="submit"><Plus size={18} />{action.busy ? '만드는 중…' : '모임 만들기'}</button>
    </form>
  </div>
}

export default function HomeClient({ tab }: { tab: HomeTab }) {
  const { account } = useAccount()
  const [historyStatus, setHistoryStatus] = useState('')
  const heading = { home: '함께 쓴 돈, 함께 정리해요', groups: '내 모임', history: '정산 기록', all: '내 계정과 설정' }[tab]
  return <>
    <section className="tab-heading"><p>{tab === 'home' ? `${account.displayName ?? '카카오 사용자'}님, 안녕하세요` : '다모아'}</p><h1>{heading}</h1></section>
    {tab === 'home' && <div className="stack"><div className="quick-actions"><Link className="primary-button" href="/home/groups">모임으로 가기</Link><Link className="secondary-button" href="/home/history">지난 내역</Link></div><h2 className="section-heading">진행 중인 회차</h2><RoundList endpoint="/api/rounds?status=active" empty="진행 중인 회차가 없어요." /><p className="help-text">회차별 금액을 따로 안내해요. 실제 송금·입금 여부는 확인하지 않아요.</p></div>}
    {tab === 'groups' && <GroupsList />}
    {tab === 'history' && <div className="stack"><p className="help-text">참여했던 모든 회차예요. 모임에서 나간 뒤에도 내역을 볼 수 있어요.</p><label className="field"><span>회차 상태</span><select value={historyStatus} onChange={event => setHistoryStatus(event.target.value)}><option value="">모든 회차</option><option value="active">진행 중</option><option value="COMPLETED">정산 종료</option></select></label><RoundList key={historyStatus} endpoint={`/api/rounds${historyStatus ? `?status=${historyStatus}` : ''}`} /></div>}
    {tab === 'all' && <section className="domain-card"><AccountPanel /></section>}
  </>
}
