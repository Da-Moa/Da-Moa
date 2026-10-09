import { AppShell } from '../../frontend/page/home/ui'

export default function HomeLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>
}
