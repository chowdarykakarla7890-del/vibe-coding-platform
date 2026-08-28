import { Readable } from 'node:stream'
import { NextRequest } from 'next/server'
import { afterEach, expect, it, vi } from 'vitest'
import { GET, POST, PUT } from '@/app/api/sandboxes/[sandboxId]/files/route'
import { ApiError, requireUser, requireOwnedSandboxRecord } from '@/lib/server/api'
import { getOwnedSandbox, sandboxForRequest } from '@/lib/server/sandbox'
import { writeSandboxFilesForRequest } from '@/lib/server/source-files'
import { SANDBOX_FILE_READ_TIMEOUT_MS } from '@/lib/server/sandbox-file-read'
import { REQUEST_BODY_TIMEOUT_MS } from '@/lib/request-body'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/server/api', async original => ({ ...await original<typeof import('@/lib/server/api')>(), requireUser: vi.fn(), requireOwnedSandboxRecord: vi.fn() }))
vi.mock('@/lib/server/sandbox', () => ({ getOwnedSandbox: vi.fn(), sandboxForRequest: vi.fn() }))
vi.mock('@/lib/server/source-files', () => ({ writeSandboxFilesForRequest: vi.fn() }))
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers() })
const context = { params: Promise.resolve({ sandboxId: 'sbx_owned' }) }
const request = (signal?: AbortSignal) => new NextRequest('http://localhost/api/test?path=main.ts', { signal })
function savedQuery(data: { content: string; revision: number; deleted: boolean } | null, error: unknown = null) {
  const query = { select: vi.fn(), eq: vi.fn(), abortSignal: vi.fn(), maybeSingle: vi.fn(async () => ({ data, error })) }
  for (const fn of [query.select, query.eq, query.abortSignal]) fn.mockReturnValue(query)
  vi.mocked(requireUser).mockResolvedValue({ user: { id: 'owner' }, supabase: { from: () => query } } as never)
  vi.mocked(requireOwnedSandboxRecord).mockResolvedValue({ project_id: 'project', status: 'expired' } as never)
  return query
}

it('reads authoritative source after expiration without contacting or resuming the VM', async () => {
  const query = savedQuery({ content: '\uFEFFsaved 🙂', revision: 7, deleted: false })
  const response = await GET(request(), context)
  expect(response.status).toBe(200)
  // Response.text() strips BOM itself; compare actual response bytes instead.
  expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from('\uFEFFsaved 🙂'))
  expect(response.headers.get('x-source-revision')).toBe('7')
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(query.eq).toHaveBeenCalledWith('user_id', 'owner')
  expect(query.eq).toHaveBeenCalledWith('project_id', 'project')
  expect(query.abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal))
  expect(getOwnedSandbox).not.toHaveBeenCalled()
})

it('does not replace deleted or temporarily unreadable saved source with older VM bytes', async () => {
  savedQuery({ content: '', revision: 8, deleted: true })
  const deleted = await GET(request(), context)
  expect(deleted.status).toBe(404)
  expect(deleted.headers.get('x-source-revision')).toBe('8')
  expect(await deleted.json()).toMatchObject({ error: { code: 'FILE_DELETED' } })
  savedQuery(null, new Error('private database detail'))
  const failed = await GET(request(), context)
  expect(failed.status).toBe(502)
  expect(await failed.json()).toMatchObject({ error: { code: 'SOURCE_READ_FAILED' } })
  expect(getOwnedSandbox).not.toHaveBeenCalled()
})

it.each([401, 404])('keeps authentication and ownership errors authoritative (%i)', async status => {
  const query = savedQuery(null)
  if (status === 401) vi.mocked(requireUser).mockRejectedValue(new ApiError(status, 'AUTH_REQUIRED', 'Sign in'))
  else vi.mocked(requireOwnedSandboxRecord).mockRejectedValue(new ApiError(status, 'SANDBOX_NOT_FOUND', 'Not found'))
  expect((await GET(request(), context)).status).toBe(status)
  expect(query.select).not.toHaveBeenCalled()
  expect(getOwnedSandbox).not.toHaveBeenCalled()
})

it('reads a new VM file with revision zero and distinguishes an absent VM file', async () => {
  savedQuery(null)
  const readFile = vi.fn().mockResolvedValueOnce(Readable.from(['new source'])).mockResolvedValueOnce(null)
  vi.mocked(getOwnedSandbox).mockResolvedValue({ readFile } as never)
  const response = await GET(request(), context)
  expect(await response.text()).toBe('new source')
  expect(response.headers.get('x-source-revision')).toBe('0')
  const missing = await GET(request(), context)
  expect(missing.status).toBe(404)
  expect(await missing.json()).toMatchObject({ error: { code: 'FILE_NOT_FOUND' } })
})

it('bounds a stalled database read and never opens the VM after a late result', async () => {
  vi.useFakeTimers()
  const query = savedQuery(null)
  let finish!: () => void
  query.maybeSingle.mockImplementation(() => new Promise(resolve => { finish = () => resolve({ data: null, error: null }) }))
  const result = GET(request(), context)
  await vi.advanceTimersByTimeAsync(SANDBOX_FILE_READ_TIMEOUT_MS)
  const response = await result
  expect(response.status).toBe(408)
  expect(await response.json()).toMatchObject({ error: { code: 'FILE_READ_INTERRUPTED' } })
  expect(query.abortSignal.mock.calls[0][0].aborted).toBe(true)
  finish()
  await vi.advanceTimersByTimeAsync(0)
  expect(getOwnedSandbox).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it.each([['PUT', PUT], ['POST', POST]] as const)('bounds a stalled %s body before mutation', async (method, handler) => {
  vi.useFakeTimers()
  const response = handler(new NextRequest('http://localhost/api/test', { method, headers: { 'content-type': 'application/json' },
    body: new ReadableStream() }), context)
  await vi.advanceTimersByTimeAsync(REQUEST_BODY_TIMEOUT_MS)
  const result = await response
  expect(result.status).toBe(408)
  expect(await result.json()).toMatchObject({ error: { code: 'REQUEST_INTERRUPTED' } })
  expect(writeSandboxFilesForRequest).not.toHaveBeenCalled()
  expect(sandboxForRequest).not.toHaveBeenCalled()
})
