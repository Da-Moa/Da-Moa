import { AppShell } from './ui'

export default function HomeLayout({ children }: { children: React.ReactNode }) {
  return <AppShell realtimeEnabled={Boolean(process.env.ABLY_API_KEY)}>{children}</AppShell>
}
