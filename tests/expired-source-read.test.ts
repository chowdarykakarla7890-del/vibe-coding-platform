import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from '@/app/api/sandboxes/[sandboxId]/files/route'
import { ApiError, requireUser } from '@/lib/server/api'
import { getOwnedSandbox } from '@/lib/server/sandbox'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/server/api', async (original) => ({ ...await original<object>(), requireUser: vi.fn() }))
vi.mock('@/lib/server/sandbox', () => ({ getOwnedSandbox: vi.fn(), sandboxForRequest: vi.fn() }))
vi.mock('@/lib/server/source-files', () => ({ writeSandboxFilesForRequest: vi.fn() }))

const row = { project_id: 'project-a', status: 'expired', expires_at: '2000-01-01T00:00:00Z' }
const registration = vi.fn()
const source = vi.fn()
const from = vi.fn()
const filters = vi.fn()
function query(result: typeof source) {
  const value = { select: vi.fn(), eq: filters, abortSignal: vi.fn(), maybeSingle: result }
  value.select.mockReturnValue(value); filters.mockReturnValue(value); value.abortSignal.mockReturnValue(value)
  return value
}
function read(path = 'main.ts', sandboxId = 'sbx_old') {
  return GET(new NextRequest(`http://localhost/api/sandboxes/${sandboxId}/files?path=${encodeURIComponent(path)}`), { params: Promise.resolve({ sandboxId }) })
}
beforeEach(() => {
  registration.mockResolvedValue({ data: row, error: null })
  source.mockResolvedValue({ data: { content: 'saved source', revision: 3 }, error: null })
  from.mockImplementation((table) => query(table === 'sandbox_sessions' ? registration : source))
  vi.mocked(requireUser).mockResolvedValue({ user: { id: 'user-a' }, supabase: { from } } as never)
  vi.mocked(getOwnedSandbox).mockRejectedValue(new ApiError(410, 'SANDBOX_EXPIRED', 'Restore your sandbox.'))
})
afterEach(() => vi.resetAllMocks())

describe('saved source after sandbox expiration', () => {
  it('returns the deletion revision instead of an old VM file or an empty source file', async () => {
    source.mockResolvedValue({ data: { content: '', deleted: true, revision: 4 }, error: null })
    const response = await read()
    expect(response.status).toBe(404)
    expect(response.headers.get('X-Source-Revision')).toBe('4')
    expect((await response.json()).error.code).toBe('FILE_DELETED')
    expect(getOwnedSandbox).not.toHaveBeenCalled()
  })

  it('returns the owned saved revision without connecting to or resuming the expired VM', async () => {
    const response = await read()
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('saved source')
    expect(response.headers.get('X-Source-Revision')).toBe('3')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(filters).toHaveBeenCalledWith('user_id', 'user-a')
    expect(filters).toHaveBeenCalledWith('project_id', 'project-a')
    expect(filters).toHaveBeenCalledWith('path', 'main.ts')
    expect(getOwnedSandbox).not.toHaveBeenCalled()
  })

  it('still returns 410 for an unsaved file that existed only in the expired VM', async () => {
    source.mockResolvedValue({ data: null, error: null })
    const response = await read()
    expect(response.status).toBe(410)
    expect((await response.json()).error.code).toBe('SANDBOX_EXPIRED')
  })

  it('does not expose source without an owned sandbox registration', async () => {
    registration.mockResolvedValue({ data: null, error: null })
    const response = await read()
    expect(response.status).toBe(404)
    expect(source).not.toHaveBeenCalled()
    expect(getOwnedSandbox).not.toHaveBeenCalled()
  })

  it('requires authentication before reading any saved data', async () => {
    vi.mocked(requireUser).mockRejectedValue(new ApiError(401, 'AUTH_REQUIRED', 'Sign in.'))
    expect((await read()).status).toBe(401)
    expect(from).not.toHaveBeenCalled()
  })

  it('reports a storage failure without falling back to an older VM copy', async () => {
    source.mockResolvedValue({ data: null, error: { message: 'private database detail' } })
    const response = await read()
    expect(response.status).toBe(502)
    expect((await response.json()).error.code).toBe('SOURCE_READ_FAILED')
    expect(getOwnedSandbox).not.toHaveBeenCalled()
  })

  it.each(['../escape', '.env.local'])('rejects unsafe path %s before reading source', async (path) => {
    expect((await read(path)).status).toBe(400)
    expect(from).not.toHaveBeenCalled()
  })
})
