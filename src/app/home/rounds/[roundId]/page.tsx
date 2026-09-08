import RoundClient from '../../round-client'

export default async function RoundPage({ params }: { params: Promise<{ roundId: string }> }) {
  const { roundId } = await params
  return <RoundClient roundId={roundId} />
}
