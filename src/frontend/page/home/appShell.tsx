'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { usePathname } from 'next/navigation'
import { History, House, Menu, Users } from 'lucide-react'
import { AccountProvider } from '../../domain/user'
import type { Account } from '../../../shared/domain/user'
import { RealtimeProvider } from '../../global/websocket'
import { ErrorNotice, Loading, useResource } from '../../global/util'

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/home'
  const hasBackButton = pathname === '/home/account' || pathname.startsWith('/home/groups/') || pathname.startsWith('/home/rounds/') || pathname.startsWith('/settlements/')
  const tabTitle = pathname === '/home/groups' ? '내 모임' : pathname === '/home/history' ? '정산 기록' : pathname === '/home/all' ? '전체' : null
  const topbarContent = pathname === '/home' ? <Link className="brand" href="/home" aria-label="다모아 홈"><Image alt="다모아" height={38} src="/logo/da-moa-trans.png" width={46} /></Link> : tabTitle ? <h1 className="topbar-title">{tabTitle}</h1> : pathname.startsWith('/invites/') ? <span className="topbar-title">모임 초대</span> : null
  const me = useResource<Account>('/api/me')
  const previousPath = useRef(pathname)
  const [checkedPath, setCheckedPath] = useState(pathname)
  const verifyPage = useCallback(async () => {
    const account = await me.reload()
    if (account && previousPath.current === pathname) setCheckedPath(pathname)
    return account
  }, [pathname, me.reload])
  useEffect(() => {
    if (previousPath.current === pathname) return
    previousPath.current = pathname
    void verifyPage()
  }, [pathname, verifyPage])
  const account = me.data
  useEffect(() => {
    if (account && (account.purpose === 'onboarding' || !account.onboardingCompletedAt || account.deletedAt)) window.location.replace(`/onboarding?returnTo=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`)
  }, [account])
  if (!account || account.purpose !== 'app' || !account.onboardingCompletedAt || account.deletedAt) return <main className="app-shell">{!hasBackButton && <header className="topbar">{topbarContent}</header>}<Loading text="로그인 상태를 확인하고 있어요…" /><ErrorNotice error={me.error} retry={() => void me.reload()} /></main>
  const links = [
    { href: '/home', label: '홈', icon: House, active: pathname === '/home' },
    { href: '/home/groups', label: '모임', icon: Users, active: pathname.startsWith('/home/groups') || pathname.startsWith('/home/rounds') },
    { href: '/home/history', label: '정산 기록', icon: History, active: pathname === '/home/history' },
    { href: '/home/all', label: '전체', icon: Menu, active: pathname === '/home/all' || pathname === '/home/account' },
  ]
  return <RealtimeProvider accountId={account.id} reloadAccount={me.reload}><AccountProvider account={account} reloadAccount={me.reload}><main className="app-shell">
    <header className="topbar">{topbarContent}</header>
    {checkedPath === pathname ? children : <><Loading text="로그인 상태를 확인하고 있어요…" /><ErrorNotice error={me.error} retry={() => void verifyPage()} /></>}
    <nav aria-label="주 메뉴" className="bottom-nav">{links.map(({ href, label, icon: Icon, active }) => <Link key={href} href={href} aria-current={active ? 'page' : undefined}><Icon size={22} /><span>{label}</span></Link>)}</nav>
  </main></AccountProvider></RealtimeProvider>
}
