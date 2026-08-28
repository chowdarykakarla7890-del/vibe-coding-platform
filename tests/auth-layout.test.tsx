import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import PlatformLayout from '@/app/(platform)/layout'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({ createServerSupabaseClient: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn(() => { throw new Error('NEXT_REDIRECT') }) }))
vi.mock('nuqs/adapters/next/app', () => ({ NuqsAdapter: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/lib/chat-context', () => ({ ChatProvider: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/lib/learning/learning-provider', () => ({ LearningProvider: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/components/platform/sidebar', () => ({ PlatformShell: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/components/error-monitor/error-monitor', () => ({ ErrorMonitor: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/components/commands-logs/commands-logs-stream', () => ({ CommandLogsStream: () => null }))
vi.mock('@/components/modals/sandbox-state', () => ({ SandboxState: () => null }))
vi.mock('@/components/learning/snapshot-observer', () => ({ ProjectSandboxSync: () => null }))
vi.mock('@/components/auth/user-workspace', () => ({ UserWorkspace: ({ children }: { children: ReactNode }) => children }))

const getUser = vi.fn()
beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.mocked(createServerSupabaseClient).mockResolvedValue({ auth: { getUser } } as never)
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it('renders recovery instead of redirecting or exposing workspace children during an outage', async () => {
  getUser.mockRejectedValue(new Error('private upstream detail'))
  const html = renderToStaticMarkup(await PlatformLayout({ children: <p>Private workspace source</p> }))
  expect(html).toContain('Unable to verify your session')
  expect(html).toContain('href=""')
  expect(html).toContain('Try again')
  expect(html).not.toContain('Private workspace source')
  expect(html).not.toContain('private upstream detail')
  expect(redirect).not.toHaveBeenCalled()
  expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private upstream detail')
})

it.each([null, { id: 'anonymous', is_anonymous: true }])('redirects genuinely signed-out users without swallowing Next navigation', async user => {
  getUser.mockResolvedValue({ data: { user }, error: null })
  await expect(PlatformLayout({ children: <p>Private workspace source</p> })).rejects.toThrow('NEXT_REDIRECT')
  expect(redirect).toHaveBeenCalledExactlyOnceWith('/sign-in')
})

it('renders an authenticated workspace after the live user check succeeds', async () => {
  getUser.mockResolvedValue({ data: { user: { id: 'owner', email: 'owner@example.invalid' } }, error: null })
  const html = renderToStaticMarkup(await PlatformLayout({ children: <p>Private workspace source</p> }))
  expect(html).toContain('Private workspace source')
  expect(html).not.toContain('Unable to verify your session')
  expect(redirect).not.toHaveBeenCalled()
})

it('does not leave a workspace navigation waiting indefinitely for Auth', async () => {
  vi.useFakeTimers()
  getUser.mockReturnValue(new Promise(() => {}))
  const result = PlatformLayout({ children: <p>Private workspace source</p> })
  await vi.advanceTimersByTimeAsync(10_001)
  const html = renderToStaticMarkup(await result)
  expect(html).toContain('Unable to verify your session')
  expect(html).not.toContain('Private workspace source')
})
