import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { POST } from '@/app/api/projects/[projectId]/source-recovery/[conflictId]/apply/route'
import { ApiError, requireUser, requireOwnedProject, requireOwnedSandbox } from '@/lib/server/api'
import { getOwnedSandbox } from '@/lib/server/sandbox'
import { applySandboxResolution } from '@/lib/sandbox/source-resolution-apply'
import { SourceApplyError } from '@/lib/sandbox/source-apply'
import { consumeQuota } from '@/lib/server/rate-limit'
import { createHash } from 'node:crypto'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/server/api', async original => ({ ...await original<typeof import('@/lib/server/api')>(), requireUser: vi.fn(), requireOwnedProject: vi.fn(), requireOwnedSandbox: vi.fn() }))
vi.mock('@/lib/server/sandbox', () => ({ getOwnedSandbox: vi.fn() }))
vi.mock('@/lib/sandbox/source-resolution-apply', () => ({ applySandboxResolution: vi.fn() }))
vi.mock('@/lib/server/rate-limit', () => ({ consumeQuota: vi.fn() }))
const projectId = '11111111-1111-4111-8111-111111111111', conflictId = '22222222-2222-4222-8222-222222222222', userId = '33333333-3333-4333-8333-333333333333'
const selected: string[] = []
const queries: Array<ReturnType<typeof query>> = []
const sourceRead = vi.fn(), conflictRead = vi.fn()
function query(table: string) {
  const chain = { select: vi.fn(), eq: vi.fn(), abortSignal: vi.fn(), maybeSingle: table === 'source_files' ? sourceRead : conflictRead }
  chain.select.mockReturnValue(chain); chain.eq.mockReturnValue(chain); chain.abortSignal.mockReturnValue(chain)
  return chain
}
const source = { content: 'merged source', revision: 3, deleted: false }
const conflict = { id: conflictId, path: 'main.ts', resolved_at: '2026-08-27T00:00:00Z', resolution_revision: 3, resolution_deleted: false, captured_content: 'terminal source' }
const input = { sandboxId: 'sbx_a', revision: 3 }
const request = (body: unknown = input, origin = 'http://localhost:3112') => POST(new Request(`http://localhost:3112/api/projects/${projectId}/source-recovery/${conflictId}/apply`, {
  method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
}), { params: Promise.resolve({ projectId, conflictId }) })
beforeEach(() => {
  vi.mocked(requireUser).mockResolvedValue({ user: { id: userId }, supabase: { from(table: string) { selected.push(table); const result = query(table); queries.push(result); return result } } } as never)
  vi.mocked(requireOwnedSandbox).mockResolvedValue({ project_id: projectId } as never)
  vi.mocked(getOwnedSandbox).mockResolvedValue({ cwd: '/vercel' } as never)
  vi.mocked(consumeQuota).mockResolvedValue({
    'X-RateLimit-Limit': '120',
    'X-RateLimit-Remaining': '119',
    'X-RateLimit-Reset': '60',
  })
  sourceRead.mockResolvedValue({ data: source, error: null }); conflictRead.mockResolvedValue({ data: conflict, error: null })
})
afterEach(() => { vi.resetAllMocks(); selected.length = 0; queries.length = 0 })

it('uses authenticated source and captured bytes, not client-controlled contents', async () => {
  const response = await request()
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ id: conflictId, sandboxId: 'sbx_a', path: 'main.ts', revision: 3, deleted: false })
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(response.headers.get('x-request-id')).toBeTruthy()
  expect(response.headers.get('x-ratelimit-limit')).toBe('120')
  expect(applySandboxResolution).toHaveBeenCalledExactlyOnceWith({ cwd: '/vercel' }, { path: 'main.ts', content: 'merged source', revision: 3, expectedDigest: createHash('sha256').update('terminal source').digest('hex') })
  expect(sourceRead).toHaveBeenCalledTimes(2)
  for (const chain of queries) {
    expect(chain.eq).toHaveBeenCalledWith('user_id', userId)
    expect(chain.eq).toHaveBeenCalledWith('project_id', projectId)
    expect(chain.abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal))
  }
})
it.each(['{', {}, { ...input, content: 'forged' }, { ...input, expectedDigest: 'forged' }, { ...input, revision: -1 }, { ...input, sandboxId: '../other' }])('rejects malformed/forged input before VM access', async body => {
  const response = await request(body)
  expect(response.status).toBe(400)
  expect(getOwnedSandbox).not.toHaveBeenCalled(); expect(applySandboxResolution).not.toHaveBeenCalled()
})
it('rejects cross-origin requests', async () => { expect((await request(input, 'https://other.example')).status).toBe(403); expect(applySandboxResolution).not.toHaveBeenCalled() })
it.each([401, 404, 410])('rejects unauthorized/missing/expired resources with %i', async status => {
  if (status === 401) vi.mocked(requireUser).mockRejectedValue(new ApiError(401, 'AUTH_REQUIRED', 'Sign in.'))
  else if (status === 404) vi.mocked(requireOwnedProject).mockRejectedValue(new ApiError(404, 'PROJECT_NOT_FOUND', 'Not found.'))
  else vi.mocked(requireOwnedSandbox).mockRejectedValue(new ApiError(410, 'SANDBOX_EXPIRED', 'Expired.'))
  const response = await request(); expect(response.status).toBe(status)
  expect((await response.json()).error.requestId).toBeTruthy()
  expect(applySandboxResolution).not.toHaveBeenCalled()
})
it('rejects a sandbox registered to another project before VM lookup', async () => {
  vi.mocked(requireOwnedSandbox).mockResolvedValue({ project_id: conflictId } as never)
  expect((await request()).status).toBe(404); expect(getOwnedSandbox).not.toHaveBeenCalled()
})
it('refuses a newer saved revision before applying an old review', async () => {
  sourceRead.mockResolvedValue({ data: { ...source, revision: 4 }, error: null })
  expect((await request()).status).toBe(409); expect(applySandboxResolution).not.toHaveBeenCalled()
})
it('does not declare current synchronization if source changes during the VM write', async () => {
  sourceRead.mockResolvedValueOnce({ data: source, error: null }).mockResolvedValueOnce({ data: { ...source, revision: 4 }, error: null })
  expect((await request()).status).toBe(409); expect(applySandboxResolution).toHaveBeenCalledOnce()
})
it('can apply a reviewed deletion without creating a source revision or running user code', async () => {
  conflictRead.mockResolvedValue({ data: { ...conflict, resolution_deleted: true, captured_content: null }, error: null })
  sourceRead.mockResolvedValue({ data: { ...source, content: '', deleted: true }, error: null })
  expect((await request()).status).toBe(200)
  expect(applySandboxResolution).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ content: null, revision: 3, expectedDigest: null }))
})
it.each(['SOURCE_COMMANDS_RUNNING', 'SOURCE_WORKSPACE_CHANGED', 'SOURCE_APPLY_BUSY', 'SOURCE_SUPERSEDED', 'SANDBOX_CLOSING'])('reports %s without losing saved copies', async code => {
  vi.mocked(applySandboxResolution).mockRejectedValue(new SourceApplyError(code))
  const response = await request(); expect(response.status).toBe(409)
  expect((await response.json()).error.code).toBe(code)
})
it('redacts unexpected VM errors', async () => {
  vi.mocked(applySandboxResolution).mockRejectedValue(new Error('private token/source sentinel'))
  const response = await request(); expect(response.status).toBe(502)
  expect(await response.text()).not.toContain('private token')
})
it('enforces quotas before application', async () => {
  vi.mocked(consumeQuota).mockRejectedValue(new ApiError(429, 'RATE_LIMITED', 'Wait.', { 'Retry-After': '60' }))
  const response = await request(); expect(response.status).toBe(429)
  expect(response.headers.get('retry-after')).toBe('60'); expect(applySandboxResolution).not.toHaveBeenCalled()
})
