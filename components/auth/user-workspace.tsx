'use client'

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { setUserStorageScope } from '@/lib/learning/db'

const WorkspaceAccount = createContext<{ userId: string; email?: string } | null>(null)
// Display identity only. API authorization still uses the verified server user.
export function useWorkspaceAccount() {
  const account = useContext(WorkspaceAccount)
  if (!account) throw new Error('Account recovery must be opened from a signed-in workspace.')
  return account
}

// Mount consumers only after selecting an account-specific cache. Never load
// the legacy shared device store implicitly into a signed-in account.
export function UserWorkspace({ userId, email, children }: { userId: string; email?: string; children: ReactNode }) {
  const [readyUser, setReadyUser] = useState<string>()
  const account = useMemo(() => ({ userId, email }), [userId, email])
  useEffect(() => {
    setUserStorageScope(userId)
    const timer = setTimeout(() => setReadyUser(userId), 0)
    return () => { clearTimeout(timer); setUserStorageScope(undefined) }
  }, [userId])
  return readyUser === userId ? <WorkspaceAccount.Provider value={account}>{children}</WorkspaceAccount.Provider> : <main className="grid h-dvh place-items-center text-sm text-muted-foreground" role="status">Opening your workspace…</main>
}
