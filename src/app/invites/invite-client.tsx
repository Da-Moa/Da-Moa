'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { apiRequest } from '../../lib/api-client'
import type { MutationResult } from '../../lib/domain-types'
import { ErrorNotice, Loading, useAction, useResource } from '../home/ui'

type InvitePreview = { groupId: string; groupName: string; isMember: boolean; expiresAt: number }

export default function InviteClient({ token }: { token: string }) {
  const router = useRouter()
  const invite = useResource<InvitePreview>(`/api/invites/${encodeURIComponent(token)}`)
  const action = useAction()
  async function accept() {
    const result = await action.run(() => apiRequest<MutationResult>(`/api/invites/${encodeURIComponent(token)}/accept`, { method: 'POST', body: {} }))
    if (result) router.push(`/home/groups/${result.id}`)
  }
  return <><section className="tab-heading"><p>모임 초대</p><h1>함께 정산해요</h1></section><ErrorNotice error={invite.error} retry={() => void invite.reload()} />
    {!invite.data ? invite.loading && <Loading /> : <section className="domain-card stack"><h2>{invite.data.groupName}</h2><p className="help-text">{new Date(invite.data.expiresAt * 1000).toLocaleString('ko-KR')}까지 수락할 수 있어요.</p>
      <p className="notice">참여를 수락하면 모임 멤버가 돼요. 이미 진행 중인 회차에는 자동으로 추가되지 않아요.</p><ErrorNotice error={action.error} />
      {invite.data.isMember ? <><p>이미 참여 중인 모임이에요.</p><Link className="primary-button" href={`/home/groups/${invite.data.groupId}`}>모임으로 가기</Link></> : <button className="primary-button" disabled={action.busy} onClick={() => void accept()} type="button">{action.busy ? '참여 중…' : '초대 수락하고 참여하기'}</button>}
      <Link className="secondary-button" href="/home">나중에 참여하기</Link>
    </section>}
  </>
}
