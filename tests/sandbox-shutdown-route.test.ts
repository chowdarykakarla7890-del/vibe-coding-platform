import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GET, DELETE } from '@/app/api/sandboxes/[sandboxId]/route'
import { ApiError, requireUser, requireOwnedSandboxRecord } from '@/lib/server/api'
import { getOwnedSandbox, stopOwnedSandbox } from '@/lib/server/sandbox'
import { readOwnedShutdown } from '@/lib/server/sandbox-shutdown'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/server/api', async original => ({ ...await original<object>(), requireUser: vi.fn(), requireOwnedSandboxRecord: vi.fn() }))
vi.mock('@/lib/server/sandbox', () => ({ getOwnedSandbox: vi.fn(), stopOwnedSandbox: vi.fn() }))
vi.mock('@/lib/server/sandbox-shutdown', () => ({ readOwnedShutdown: vi.fn() }))
const context = { params: Promise.resolve({ sandboxId: 'sandbox-a' }) }
const queued = { status: 'stopping' as const, stopped: false, shutdown: { jobId: crypto.randomUUID(), state: 'saving' as const, saved: false, hasConflicts: false } }
beforeEach(() => {
  vi.mocked(requireUser).mockResolvedValue({ user: { id: 'owner' } } as never)
  vi.mocked(requireOwnedSandboxRecord).mockResolvedValue({ id: 'registration' } as never)
  vi.mocked(stopOwnedSandbox).mockResolvedValue(queued)
})
afterEach(() => vi.resetAllMocks())
it('returns 202 for durable acceptance, not a false stopped receipt', async () => {
  const response = await DELETE(new Request('http://localhost/api/sandboxes/sandbox-a', { method: 'DELETE', headers: { origin: 'http://localhost' } }), context)
  expect(response.status).toBe(202)
  expect(response.headers.get('Retry-After')).toBe('3')
  expect(await response.json()).toEqual(queued)
})
it('returns progress without touching or resuming a stopping VM', async () => {
  vi.mocked(readOwnedShutdown).mockResolvedValue(queued)
  const response = await GET(new Request('http://localhost/api/sandboxes/sandbox-a'), context)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(queued)
  expect(getOwnedSandbox).not.toHaveBeenCalled()
})
it('rejects unauthenticated Stop before any reservation', async () => {
  vi.mocked(requireUser).mockRejectedValue(new ApiError(401, 'AUTH_REQUIRED', 'Sign in.'))
  expect((await DELETE(new Request('http://localhost/api/sandboxes/sandbox-a', { method: 'DELETE' }), context)).status).toBe(401)
  expect(stopOwnedSandbox).not.toHaveBeenCalled()
})
it('rejects cross-site Stop before any reservation', async () => {
  expect((await DELETE(new Request('http://localhost/api/sandboxes/sandbox-a', { method: 'DELETE', headers: { origin: 'https://other.example' } }), context)).status).toBe(403)
  expect(stopOwnedSandbox).not.toHaveBeenCalled()
})
