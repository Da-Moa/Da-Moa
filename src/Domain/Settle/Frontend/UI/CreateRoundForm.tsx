'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiRequest, SheetSelect, useAction } from '../../../../Global/Util/Frontend'
import { CURRENCIES, CURRENCY_CODES } from '../../../../lib/money'
import type { Member, MutationResult } from '../../../../lib/domain-types'

export function CreateRoundForm({ groupId, members, userId, action }: { groupId: string; members: Member[]; userId: string; action: ReturnType<typeof useAction> }) {
  const router = useRouter()
  const [currency, setCurrency] = useState('KRW')
  const roundMemberCandidates = [...members.filter(member => member.userId === userId), ...members.filter(member => member.userId !== userId)]
  async function start(form: HTMLFormElement) {
    const values = new FormData(form)
    const participantIds = [...new Set([userId, ...values.getAll('participantIds').map(String)])]
    const result = await action.run(() => apiRequest<MutationResult>(`/api/groups/${groupId}/rounds`, { method: 'POST', body: { name: String(values.get('name') ?? ''), currency: String(values.get('currency') ?? ''), participantIds } }))
    if (result) router.push(`/home/rounds/${result.roundId ?? result.id}`)
  }
  return <form className="domain-card stack" onSubmit={event => { event.preventDefault(); void start(event.currentTarget) }}>
    <h2>새 회차 기록 시작</h2><label className="field line-field"><span>회차 이름</span><input autoComplete="off" name="name" maxLength={100} placeholder=" " required /></label>
    <SheetSelect disabled={action.busy} label="이번 회차 통화" name="currency" onChange={setCurrency} options={CURRENCY_CODES.map(code => ({ value: code, label: CURRENCIES[code].name, searchText: `${code} ${CURRENCIES[code].countries}`, icon: <img alt="" draggable={false} height={18} src={`/flags/${CURRENCIES[code].flag}.svg`} width={24} /> }))} searchPlaceholder="통화 또는 나라 검색" sheetClassName="currency-sheet" title="통화를 선택해 주세요" value={currency} />
    <fieldset className="member-picker"><legend>이번 회차 멤버 · 최소 2명</legend>{roundMemberCandidates.map(member => <label key={member.userId} className="check-row"><input type="checkbox" name="participantIds" value={member.userId} defaultChecked disabled={member.userId === userId} /><span>{member.displayName}{member.userId === userId ? ' (회차 생성자 · 필수)' : ''}</span></label>)}</fieldset>
    <button className="primary-button" disabled={action.busy || members.length < 2} type="submit">{action.busy ? '처리 중…' : '이 멤버로 기록 시작'}</button>
  </form>
}
