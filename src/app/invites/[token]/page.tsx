import { AppShell } from '../../../frontend/page/home/ui'
import { InviteClient } from '../../../frontend/domain/group'

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return <AppShell><InviteClient token={token} /></AppShell>
}
