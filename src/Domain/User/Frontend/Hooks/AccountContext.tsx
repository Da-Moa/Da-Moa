'use client'

import { createContext, useContext, type ReactNode } from 'react'
import type { Account } from '../../Shared'

const AccountContext = createContext<{ account: Account; reloadAccount: () => Promise<Account | null> } | null>(null)
export function useAccount() {
  const value = useContext(AccountContext)
  if (!value) throw new Error('Account provider required')
  return value
}

export function AccountProvider({ account, reloadAccount, children }: { account: Account; reloadAccount: () => Promise<Account | null>; children: ReactNode }) {
  return <AccountContext.Provider value={{ account, reloadAccount }}>{children}</AccountContext.Provider>
}
