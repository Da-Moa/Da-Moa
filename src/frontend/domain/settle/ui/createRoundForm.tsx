'use client'

import { useRouter } from 'next/navigation'
import { useAction } from '../../../global/util'
import type { Member } from '../../../../shared/domainTypes'
import { createRoundRequest } from '../requests'

export function CreateRoundForm({ groupId, members, userId, action }: { groupId: string; members: Member[]; userId: string; action: ReturnType<typeof useAction> }) {
  const router = useRouter()
  const roundMemberCandidates = [...members.filter(member => member.userId === userId), ...members.filter(member => member.userId !== userId)]
  async function start(form: HTMLFormElement) {
    const values = new FormData(form)
    const participantIds = [...new Set([userId, ...values.getAll('participantIds').map(String)])]
    const result = await action.run(() => createRoundRequest(groupId, { name: String(values.get('name') ?? ''), participantIds }))
    if (result) router.push(`/home/rounds/${result.roundId ?? result.id}`)
  }
  return <form className="domain-card stack" onSubmit={event => { event.preventDefault(); void start(event.currentTarget) }}>
    <h2>새 회차 기록 시작</h2><label className="field line-field"><span>회차 이름</span><input autoComplete="off" name="name" maxLength={100} placeholder=" " required /></label>
    <fieldset className="member-picker"><legend>이번 회차 멤버 · 최소 2명</legend>{roundMemberCandidates.map(member => <label key={member.userId} className="check-row"><input type="checkbox" name="participantIds" value={member.userId} defaultChecked disabled={member.userId === userId} /><span>{member.displayName}{member.userId === userId ? ' (회차 생성자 · 필수)' : ''}</span></label>)}</fieldset>
    <button className="primary-button" disabled={action.busy || members.length < 2} type="submit">{action.busy ? '처리 중…' : '이 멤버로 기록 시작'}</button>
  </form>
}
