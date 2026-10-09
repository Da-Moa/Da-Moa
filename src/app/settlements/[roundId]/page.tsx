import { AppShell } from '../../../frontend/page/home/ui'
import { SettlementClient } from '../../../frontend/domain/settle'

export default async function SettlementPage({ params }: { params: Promise<{ roundId: string }> }) {
  const { roundId } = await params
  return <AppShell><SettlementClient roundId={roundId} /></AppShell>
}
