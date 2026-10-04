'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronRight, Plus, Search } from 'lucide-react'
import { apiRequest, ErrorNotice, Loading, ParticipantAvatar, useAction, useResource } from '../../../../Global/Util/Frontend'
import type { Page } from '../../../../lib/domain-types'
import type { GroupListItem } from '../../Shared'
import { createGroupRequest } from '../Requests'

export function GroupsList() {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const query = new URLSearchParams()
  if (search.trim()) query.set('q', search.trim())
  const endpoint = `/api/groups${query.size ? `?${query}` : ''}`
  const currentEndpoint = useRef(endpoint)
  currentEndpoint.current = endpoint
  const groups = useResource<Page<GroupListItem>>(endpoint)
  const action = useAction()
  const more = useAction()
  async function create(form: HTMLFormElement) {
    const values = new FormData(form)
    const result = await action.run(() => createGroupRequest({ name: String(values.get('name') ?? '') }))
    if (result) router.push(`/home/groups/${result.id}`)
  }
  async function loadMore() {
    if (!groups.data?.nextCursor) return
    const url = new URL(endpoint, window.location.origin)
    url.searchParams.set('cursor', groups.data.nextCursor)
    const page = await more.run(() => apiRequest<Page<GroupListItem>>(`${url.pathname}${url.search}`))
    if (page && currentEndpoint.current === endpoint) groups.setData(current => current ? { items: [...current.items, ...page.items.filter(item => !current.items.some(existing => existing.id === item.id))], nextCursor: page.nextCursor } : page)
  }
  return <div className="stack">
    <form className="domain-card stack" onSubmit={event => { event.preventDefault(); void create(event.currentTarget) }}>
      <h2>새 모임 만들기</h2>
      <label className="field line-field"><span>모임 이름</span><input autoComplete="off" maxLength={100} name="name" placeholder=" " required /></label>
      <ErrorNotice error={action.error} />
      <button className="primary-button" disabled={action.busy} type="submit"><Plus size={18} />{action.busy ? '만드는 중…' : '모임 만들기'}</button>
    </form>
    <hr className="group-section-divider" />
    <div className="round-search-bar"><Search aria-hidden="true" size={21} /><input aria-label="모임 검색어" autoComplete="off" maxLength={100} onChange={event => setSearch(event.target.value)} placeholder="모임명 검색" type="search" value={search} /></div>
    <ErrorNotice error={groups.error} retry={() => void groups.reload()} />
    {groups.loading && !groups.data && <Loading />}
    {groups.data?.items.length === 0 && <p className="empty-card">{search.trim() ? '검색 결과가 없어요.' : '모임을 만들거나 초대 링크를 받아 참여해 주세요.'}</p>}
    {groups.data?.items.map(group => <Link className="domain-card group-link" key={group.id} href={`/home/groups/${group.id}`}>
      <span aria-hidden="true" className="group-avatar-stack">{group.memberPreview.slice(0, 3).map(member => <ParticipantAvatar key={member.userId} profileImageUrl={member.profileImageUrl} />)}</span>
      <div><h2>{group.name}</h2><p className="help-text">{group.memberPreview.slice(0, 3).map(member => member.displayName).join(', ')}{group.memberCount > 3 ? ` 외 ${group.memberCount - 3}명` : ''}</p></div>
      <ChevronRight size={20} />
    </Link>)}
    <ErrorNotice error={more.error} retry={() => void loadMore()} />
    {groups.data?.nextCursor && <button className="secondary-button" disabled={more.busy} type="button" onClick={() => void loadMore()}>모임 더 보기</button>}
  </div>
}

