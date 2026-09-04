import { notFound } from 'next/navigation'
import { renderAuthenticatedHome, type HomeTab } from '../authenticated-home'

const tabs: HomeTab[] = ['groups', 'history', 'all']

export default async function HomeTabPage({
  params,
}: Readonly<{ params: Promise<{ tab: string }> }>) {
  const { tab } = await params
  if (!tabs.includes(tab as HomeTab)) notFound()
  return renderAuthenticatedHome(tab as HomeTab)
}
