'use client'

import { useAccount } from '../../domain/user'

import { useState } from 'react'
import Link from 'next/link'
import { ChevronRight, CircleUserRound, History, Search, Users } from 'lucide-react'
import type { HomeTab } from './authenticatedHome'
import { GroupsList } from '../../domain/group'
import { RoundList } from '../../domain/settle'

export default function HomeClient({ tab }: { tab: HomeTab }) {
  const { account } = useAccount()
  const [historyStatus, setHistoryStatus] = useState('')
  const [historySearch, setHistorySearch] = useState('')
  const historyQuery = new URLSearchParams()
  if (historyStatus) historyQuery.set('status', historyStatus)
  if (historySearch.trim()) historyQuery.set('q', historySearch.trim())
  const historyEndpoint = `/api/rounds${historyQuery.size ? `?${historyQuery}` : ''}`
  return <>
    {tab === 'home' && <section className="tab-heading"><p>{account.displayName ?? '카카오 사용자'}님, 안녕하세요</p><h1>함께 쓴 돈, 함께 정리해요</h1></section>}
    {tab === 'home' && <div className="stack"><div className="quick-actions"><Link className="primary-button" href="/home/groups">모임으로 가기</Link><Link className="secondary-button" href="/home/history">지난 내역</Link></div><h2 className="section-heading">진행 중인 회차</h2><RoundList endpoint="/api/rounds?status=active" empty="진행 중인 회차가 없어요." /></div>}
    {tab === 'groups' && <GroupsList />}
    {tab === 'history' && <div className="stack"><div className="round-search-bar"><Search aria-hidden="true" size={21} /><input aria-label="정산 기록 검색어" autoComplete="off" maxLength={100} onChange={event => setHistorySearch(event.target.value)} placeholder="모임명 또는 회차명 검색" type="search" value={historySearch} /></div><div aria-label="회차 상태" className="round-status-filters" role="group"><button aria-pressed={historyStatus === ''} className="round-status-filter" onClick={() => setHistoryStatus('')} type="button">전체</button><button aria-pressed={historyStatus === 'active'} className="round-status-filter" onClick={() => setHistoryStatus('active')} type="button">진행 중</button><button aria-pressed={historyStatus === 'COMPLETED'} className="round-status-filter" onClick={() => setHistoryStatus('COMPLETED')} type="button">정산 종료</button></div><RoundList key={historyEndpoint} endpoint={historyEndpoint} empty={historySearch.trim() ? '검색 결과가 없어요.' : undefined} /></div>}
    {tab === 'all' && <div className="stack">
      <section className="all-menu-section" aria-labelledby="all-settlement-heading"><h2 className="section-heading" id="all-settlement-heading">정산</h2><div className="all-functions">
        <Link className="all-function-row" href="/home/groups"><span className="all-function-icon"><Users size={23} /></span><span className="all-function-copy"><strong>내 모임</strong><small>모임과 회차 보기</small></span><ChevronRight size={20} /></Link>
        <Link className="all-function-row" href="/home/history"><span className="all-function-icon"><History size={23} /></span><span className="all-function-copy"><strong>정산 기록</strong><small>지난 회차 보기</small></span><ChevronRight size={20} /></Link>
      </div></section>
      <section className="all-menu-section" aria-labelledby="all-account-heading"><h2 className="section-heading" id="all-account-heading">내 정보</h2><div className="all-functions">
        <Link className="all-function-row" href="/home/account"><span className="all-function-icon"><CircleUserRound size={23} /></span><span className="all-function-copy"><strong>계좌 설정</strong><small>프로필 · 정산용 계좌</small></span><ChevronRight size={20} /></Link>
      </div></section>
    </div>}
  </>
}
