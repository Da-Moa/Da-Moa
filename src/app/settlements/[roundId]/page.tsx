import { AppShell } from '../../home/ui'
import { SettlementClient } from '../../../Domain/Settle/Frontend'

export default async function SettlementPage({ params }: { params: Promise<{ roundId: string }> }) {
  const { roundId } = await params
  return <AppShell><SettlementClient roundId={roundId} /></AppShell>
}
