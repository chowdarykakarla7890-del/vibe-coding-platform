import { NuqsAdapter } from 'nuqs/adapters/next/app'
import { ChatProvider } from '@/lib/chat-context'
import { CommandLogsStream } from '@/components/commands-logs/commands-logs-stream'
import { ErrorMonitor } from '@/components/error-monitor/error-monitor'
import { SandboxState } from '@/components/modals/sandbox-state'
import { LearningProvider } from '@/lib/learning/learning-provider'
import { PlatformShell } from '@/components/platform/sidebar'
import { ProjectSandboxSync } from '@/components/learning/snapshot-observer'
import { UserWorkspace } from '@/components/auth/user-workspace'
import { readAuthenticatedUser } from '@/lib/auth/server-session'
import { AuthUnavailableError } from '@/lib/auth/session-check'
import { AuthenticationUnavailable } from '@/components/auth/auth-unavailable'
import { redirect } from 'next/navigation'
import { Suspense, type ReactNode } from 'react'

export const dynamic = 'force-dynamic'

export default async function PlatformLayout({ children }: { children: ReactNode }) {
  let context: Awaited<ReturnType<typeof readAuthenticatedUser>>
  try { context = await readAuthenticatedUser() }
  catch (error) {
    if (!(error instanceof AuthUnavailableError)) throw error
    console.warn('Authentication check unavailable', { requestId: crypto.randomUUID(), code: 'AUTH_UNAVAILABLE', context: 'workspace' })
    return <AuthenticationUnavailable />
  }
  const { user } = context
  if (!user) redirect('/sign-in')
  return <Suspense fallback={<p role="status">Opening workspace…</p>}><UserWorkspace userId={user.id} email={user.email}><NuqsAdapter><LearningProvider><ChatProvider><PlatformShell><ErrorMonitor>{children}</ErrorMonitor></PlatformShell><ProjectSandboxSync /></ChatProvider><SandboxState /></LearningProvider><CommandLogsStream /></NuqsAdapter></UserWorkspace></Suspense>
}
