import { afterEach, expect, it, vi } from 'vitest'
import { writeSandboxFilesForRequest } from '@/lib/server/source-files'
import { requireUser } from '@/lib/server/api'
import { consumeQuota } from '@/lib/server/rate-limit'
import { getOwnedSandbox } from '@/lib/server/sandbox'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/server/api', async original => ({ ...await original<typeof import('@/lib/server/api')>(), requireUser: vi.fn() }))
vi.mock('@/lib/server/rate-limit', () => ({ consumeQuota: vi.fn() }))
vi.mock('@/lib/server/sandbox', () => ({ getOwnedSandbox: vi.fn() }))
afterEach(() => vi.resetAllMocks())

it.each(['before auth', 'during auth', 'during quota'])('does not begin file writes cancelled %s', async phase => {
  const controller = new AbortController()
  if (phase === 'before auth') controller.abort()
  vi.mocked(requireUser).mockImplementation(async () => {
    if (phase === 'during auth') controller.abort()
    return { user: { id: 'owner' }, supabase: {} } as never
  })
  vi.mocked(consumeQuota).mockImplementation(async () => {
    if (phase === 'during quota') controller.abort()
    return {} as never
  })
  const request = new Request('http://localhost/api/test', { method: 'PUT', headers: { origin: 'http://localhost' }, signal: controller.signal })
  await expect(writeSandboxFilesForRequest(request, 'sbx_owned', [{ path: 'main.ts', content: 'draft' }])).rejects.toMatchObject({ status: 408, code: 'REQUEST_INTERRUPTED' })
  expect(getOwnedSandbox).not.toHaveBeenCalled()
  if (phase === 'before auth') expect(requireUser).not.toHaveBeenCalled()
  if (phase !== 'during quota') expect(consumeQuota).not.toHaveBeenCalled()
})
