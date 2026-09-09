'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { apiRequest } from '../../lib/api-client'
import type { GroupDetail, MutationResult } from '../../lib/domain-types'
import { CopyLink, ErrorNotice, Loading, useAccount, useAction, useResource } from './ui'
import { RoundList } from './home-client'

export default function GroupClient({ groupId }: { groupId: string }) {
  const router = useRouter()
  const { account } = useAccount()
  const group = useResource<GroupDetail>(`/api/groups/${groupId}`)
  const action = useAction()
  const departure = useAction()
  const [invite, setInvite] = useState<{ id: string; path: string | null } | null>(null)
  const data = group.data
  async function inviteMembers(replaceInviteId?: string) {
    const result = await action.run(() => apiRequest<MutationResult>(`/api/groups/${groupId}/invites`, { method: 'POST', body: replaceInviteId ? { replaceInviteId } : {} }))
    if (result) { setInvite({ id: result.inviteId ?? result.id, path: result.sharePath ?? null }); await group.reload() }
  }
  async function revoke(inviteId: string) {
    if (!window.confirm('이 초대 링크를 폐기할까요? 이미 참여한 멤버는 유지돼요.')) return
    const result = await action.run(() => apiRequest(`/api/groups/${groupId}/invites/${inviteId}`, { method: 'DELETE' }))
    if (result) { if (invite?.id === inviteId) setInvite(null); await group.reload() }
  }
  async function start(form: HTMLFormElement) {
    const values = new FormData(form)
    const participantIds = [...new Set([account.id, ...values.getAll('participantIds').map(String)])]
    const result = await action.run(() => apiRequest<MutationResult>(`/api/groups/${groupId}/rounds`, { method: 'POST', body: { name: String(values.get('name') ?? ''), currency: String(values.get('currency') ?? ''), participantIds } }))
    if (result) router.push(`/home/rounds/${result.roundId ?? result.id}`)
  }
  async function leave() {
    const prompt = data!.isCreator
      ? `“${data!.name}” 모임을 없앨까요?\n종료되지 않은 회차가 있으면 없앨 수 없어요. 모임은 목록에서 사라지지만 완료된 정산 기록은 유지돼요.`
      : `“${data!.name}” 모임에서 나갈까요?\n참여 중인 회차가 있으면 나갈 수 없어요. 다시 참여하려면 새 초대 링크가 필요하며 과거 정산 기록은 유지돼요.`
    if (!window.confirm(prompt)) return
    const result = await departure.run(() => apiRequest(`/api/groups/${groupId}`, { method: 'DELETE' }))
    if (result) router.replace('/home/groups')
  }
  return <>
    <Link className="back-link" href="/home/groups">← 내 모임</Link>
    <ErrorNotice error={group.error} retry={() => void group.reload()} />
    {!data ? group.loading && <Loading /> : <div className="stack">
      <section className="tab-heading compact"><h1>{data.name}</h1></section>
      <section className="domain-card stack"><h2>현재 멤버 {data.members.length}명</h2><ul className="member-list">{data.members.map(member => <li key={member.userId}><span>{member.displayName}</span>{member.userId === data.creatorId && <span className="subtle-tag">모임 생성자</span>}</li>)}</ul><p className="help-text">새 멤버는 다음에 시작하는 회차부터 참여할 수 있어요.</p>
        {data.isCreator && <>
          <button className="secondary-button" disabled={action.busy} onClick={() => void inviteMembers()} type="button">초대 링크 만들기</button>
          {invite?.path && <CopyLink path={invite.path} label="초대 링크 복사" />}
          {invite && !invite.path && <div className="notice"><p>초대는 발급됐지만 링크를 다시 표시할 수 없어요. 이전 링크를 폐기하고 다시 발급해 주세요.</p><button className="secondary-button" disabled={action.busy} onClick={() => void inviteMembers(invite.id)} type="button">링크 다시 발급</button></div>}
          {data.invites.length > 0 && <details><summary>유효한 초대 {data.invites.length}개 관리</summary><ul className="member-list">{data.invites.map(item => <li key={item.id}><span>{new Date(item.expiresAt * 1000).toLocaleDateString('ko-KR')}까지 유효</span><span className="inline-actions"><button className="text-button" disabled={action.busy} type="button" onClick={() => void inviteMembers(item.id)}>재발급</button><button className="text-button danger-text" disabled={action.busy} type="button" onClick={() => void revoke(item.id)}>폐기</button></span></li>)}</ul></details>}
        </>}
      </section>
      <ErrorNotice error={action.error} />
      <form className="domain-card stack" onSubmit={event => { event.preventDefault(); void start(event.currentTarget) }}>
        <h2>새 회차 기록 시작</h2><label className="field"><span>회차 이름</span><input autoComplete="off" name="name" maxLength={100} placeholder="예: 9월 첫 모임" required /></label>
        <label className="field"><span>이번 회차 통화</span><select defaultValue="KRW" name="currency" required><option value="KRW">KRW · 원</option><option value="USD">USD · 달러</option><option value="JPY">JPY · 엔</option></select></label>
        <p className="help-text">회차마다 통화를 고를 수 있으며, 생성한 회차의 통화는 바꿀 수 없어요. USD·JPY 정산은 금액만 안내해요.</p>
        <fieldset className="member-picker"><legend>이번 회차 멤버 · 최소 2명</legend>{data.members.map(member => <label key={member.userId} className="check-row"><input type="checkbox" name="participantIds" value={member.userId} defaultChecked disabled={member.userId === account.id} /><span>{member.displayName}{member.userId === account.id ? ' (회차 생성자 · 필수)' : ''}</span></label>)}</fieldset>
        <p className="help-text">모임 참여자 누구나 회차를 시작할 수 있고, 시작한 사람이 회차를 관리해요. 기존 회차가 진행 중이어도 새로 시작할 수 있어요.</p>
        {data.members.length < 2 && <p className="notice">초대 링크로 멤버가 참여하면 시작할 수 있어요.</p>}
        <button className="primary-button" disabled={action.busy || data.members.length < 2} type="submit">{action.busy ? '처리 중…' : '이 멤버로 기록 시작'}</button>
      </form>
      <h2 className="section-heading">내가 참여한 회차</h2><RoundList endpoint={`/api/groups/${groupId}/rounds`} />
      <section className="domain-card stack"><h2>모임 관리</h2><p className="help-text">{data.isCreator ? '모임 전체의 회차가 모두 종료되면 없앨 수 있으며, 완료된 정산 기록은 유지돼요.' : '내가 참여 중인 미종료 회차가 있으면 나갈 수 없으며, 과거 정산 기록은 유지돼요.'}</p><ErrorNotice error={departure.error} /><button className="secondary-button danger-text" disabled={departure.busy} onClick={() => void leave()} type="button">{departure.busy ? '처리 중…' : data.isCreator ? '모임 없애기' : '모임 나가기'}</button></section>
    </div>}
  </>
}
