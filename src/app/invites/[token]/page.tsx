import { AppShell } from '../../home/ui'
import InviteClient from '../invite-client'

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return <AppShell realtimeEnabled={Boolean(process.env.ABLY_API_KEY)}><InviteClient token={token} /></AppShell>
}
