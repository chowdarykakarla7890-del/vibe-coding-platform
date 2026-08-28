import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { ApiError, requireOwnedSandboxRecord, requireUser } from '@/lib/server/api'
import { getOwnedSandbox, sandboxForRequest } from '@/lib/server/sandbox'
import { writeSandboxFilesForRequest } from '@/lib/server/source-files'
import { startOwnedCommand } from '@/lib/server/owned-command'
import { GET as status } from '@/app/api/sandboxes/[sandboxId]/route'
import { GET as readFile } from '@/app/api/sandboxes/[sandboxId]/files/route'
import { PUT as restore } from '@/app/api/sandboxes/[sandboxId]/snapshot/route'
import { POST as terminal } from '@/app/api/sandboxes/[sandboxId]/terminal/route'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/server/sandbox', () => ({ sandboxForRequest: vi.fn(), getOwnedSandbox: vi.fn(), stopOwnedSandbox: vi.fn() }))
vi.mock('@/lib/server/source-files', () => ({ writeSandboxFilesForRequest: vi.fn() }))
vi.mock('@/lib/server/owned-command', () => ({ startOwnedCommand: vi.fn() }))
vi.mock('@/lib/server/api', async (original) => ({ ...await original<typeof import('@/lib/server/api')>(), requireUser: vi.fn(), requireOwnedSandboxRecord: vi.fn() }))
afterEach(() => { vi.resetAllMocks() })

describe('expired sandbox API responses', () => {
  it.each([
    ['status', status, 'GET', '', undefined],
    ['file', readFile, 'GET', '?path=src/main.ts', undefined],
    ['restore', restore, 'PUT', '', { files: [{ path: 'src/main.ts', content: 'const value = 1' }] }],
    ['terminal', terminal, 'POST', '', { command: 'node --version' }],
  ] as const)('%s returns a recoverable 410 rather than an empty 500', async (_name, handler, method, query, body) => {
    vi.mocked(sandboxForRequest).mockRejectedValue(new ApiError(410, 'SANDBOX_EXPIRED', 'This sandbox expired. Restore your project to continue.'))
    const sourceQuery = { select: vi.fn(), eq: vi.fn(), abortSignal: vi.fn(), maybeSingle: vi.fn(async () => ({ data: null, error: null })) }
    sourceQuery.select.mockReturnValue(sourceQuery); sourceQuery.eq.mockReturnValue(sourceQuery); sourceQuery.abortSignal.mockReturnValue(sourceQuery)
    vi.mocked(requireUser).mockResolvedValue({ user: { id: 'test-user' }, supabase: { from: () => sourceQuery } } as never)
    vi.mocked(requireOwnedSandboxRecord).mockResolvedValue({ project_id: 'test-project' } as never)
    vi.mocked(getOwnedSandbox).mockRejectedValue(new ApiError(410, 'SANDBOX_EXPIRED', 'This sandbox expired. Restore your project to continue.'))
    vi.mocked(writeSandboxFilesForRequest).mockRejectedValue(new ApiError(410, 'SANDBOX_EXPIRED', 'This sandbox expired. Restore your project to continue.'))
    vi.mocked(startOwnedCommand).mockRejectedValue(new ApiError(410, 'SANDBOX_EXPIRED', 'This sandbox expired. Restore your project to continue.'))
    const response = await handler(new NextRequest(`http://localhost/api/test${query}`, {
      method,
      ...(body ? { headers: { 'content-type': 'application/json', origin: 'http://localhost' }, body: JSON.stringify(body) } : {}),
    }), { params: Promise.resolve({ sandboxId: 'sbx_expired' }) })
    expect(response.status).toBe(410)
    expect(await response.json()).toMatchObject({ error: { code: 'SANDBOX_EXPIRED', requestId: expect.any(String), message: expect.stringContaining('Restore') } })
    expect(response.headers.get('cache-control')).toContain('no-store')
  })
})
