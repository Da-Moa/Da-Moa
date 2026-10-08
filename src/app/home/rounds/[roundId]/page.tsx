import { RoundClient } from '../../../../frontend/domain/settle'

export default async function RoundPage({ params }: { params: Promise<{ roundId: string }> }) {
  const { roundId } = await params
  return <RoundClient roundId={roundId} />
}
