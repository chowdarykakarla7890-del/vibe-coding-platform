import { afterEach, expect, it, vi } from 'vitest'
import { after } from 'next/server'
import { scheduleSandboxCleanup } from '@/lib/server/sandbox-cleanup-dispatch'
import { runSandboxCleanupBatch } from '@/lib/server/sandbox-cleanup-worker'

vi.mock('server-only', () => ({}))
vi.mock('next/server', () => ({ after: vi.fn() }))
vi.mock('@/lib/server/sandbox-cleanup-worker', () => ({ runSandboxCleanupBatch: vi.fn() }))
afterEach(() => { vi.resetAllMocks(); vi.restoreAllMocks() })
it('does no work without IDs and defers work until after the response', async () => {
  scheduleSandboxCleanup([])
  expect(after).not.toHaveBeenCalled()
  scheduleSandboxCleanup(['id'])
  expect(runSandboxCleanupBatch).not.toHaveBeenCalled()
  vi.mocked(runSandboxCleanupBatch).mockResolvedValue({ processed: 1, failed: 0, unconfirmed: 0 })
  const callback = vi.mocked(after).mock.calls[0][0] as () => Promise<void>
  await callback()
  expect(runSandboxCleanupBatch).toHaveBeenCalledWith(['id'])
})
it('leaves durable retry ownership intact when post-response dispatch fails', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  scheduleSandboxCleanup(['id'])
  vi.mocked(runSandboxCleanupBatch).mockRejectedValue(new Error('private provider payload'))
  const callback = vi.mocked(after).mock.calls[0][0] as () => Promise<void>
  await expect(callback()).resolves.toBeUndefined()
  vi.mocked(after).mockImplementation(() => { throw new Error('no request context') })
  expect(() => scheduleSandboxCleanup(['id'])).not.toThrow()
  expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private')
})
