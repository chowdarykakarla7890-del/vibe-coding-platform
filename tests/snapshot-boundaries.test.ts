import { Readable } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { POST, PUT } from '@/app/api/sandboxes/[sandboxId]/snapshot/route'
import { ApiError } from '@/lib/server/api'
import { sandboxForRequest } from '@/lib/server/sandbox'
import { writeSandboxFilesForRequest } from '@/lib/server/source-files'
import { SANDBOX_FILE_READ_TIMEOUT_MS } from '@/lib/server/sandbox-file-read'
import { REQUEST_BODY_TIMEOUT_MS } from '@/lib/request-body'
import { MAX_SOURCE_FILE_BYTES } from '@/lib/learning/snapshots'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/server/source-files', () => ({ writeSandboxFilesForRequest: vi.fn() }))
vi.mock('@/lib/server/sandbox', () => ({ sandboxForRequest: vi.fn() }))
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers() })
const context = { params: Promise.resolve({ sandboxId: 'sbx_owned' }) }
function request(method: string, body: unknown, signal?: AbortSignal) {
  return new Request('http://localhost/api/test', { method, headers: { 'content-type': 'application/json', origin: 'http://localhost' }, body: JSON.stringify(body), signal })
}
async function errorResponse(response: Response, status: number, code: string) {
  expect(response.status).toBe(status)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(await response.json()).toMatchObject({ error: { code, requestId: response.headers.get('x-request-id') } })
}

it.each([
  { paths: ['../secret'] }, { paths: ['.env'] }, { paths: ['src', 'src/main.ts'] },
  { paths: ['main.ts'], extra: true }, { paths: Array(201).fill('main.ts') },
])('rejects invalid snapshot paths before opening a sandbox: %j', async body => {
  await errorResponse(await POST(request('POST', body), context), 400, 'INVALID_SNAPSHOT')
  expect(sandboxForRequest).not.toHaveBeenCalled()
})

it.each([
  { files: [{ path: 'main.ts', content: 'a' }, { path: 'main.ts', content: 'b' }] },
  { files: [{ path: 'src', content: '' }, { path: 'src/main.ts', content: '' }] },
  { files: [{ path: 'main.ts', content: 'x\0' }] },
  { files: [{ path: 'main.ts', content: '', unexpected: true }] },
  { files: [], unexpected: true },
])('rejects ambiguous restore payloads before writing: %j', async body => {
  await errorResponse(await PUT(request('PUT', body), context), 400, 'INVALID_SNAPSHOT')
  expect(writeSandboxFilesForRequest).not.toHaveBeenCalled()
  expect(sandboxForRequest).not.toHaveBeenCalled()
})

it('deduplicates reads and explicitly reports excluded files', async () => {
  const readFile = vi.fn(async ({ path }: { path: string }) => {
    if (path === 'missing.ts') return null
    return Readable.from([path === 'large.ts' ? Buffer.alloc(MAX_SOURCE_FILE_BYTES + 1, 65) : path === 'binary.ts' ? Buffer.from([0xff]) : Buffer.from('🙂')])
  })
  vi.mocked(sandboxForRequest).mockResolvedValue({ readFile } as never)
  const response = await POST(request('POST', { paths: ['main.ts', 'main.ts', 'missing.ts', 'large.ts', 'binary.ts'] }), context)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ files: [{ path: 'main.ts', content: '🙂' }], totalBytes: 4, complete: false,
    skipped: [{ path: 'missing.ts', reason: 'not-found' }, { path: 'large.ts', reason: 'too-large' }, { path: 'binary.ts', reason: 'not-text' }] })
  expect(readFile).toHaveBeenCalledTimes(4)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
})

it('limits escaped response bytes instead of returning a truncated snapshot', async () => {
  const readFile = vi.fn(async () => Readable.from(['\u0001'.repeat(MAX_SOURCE_FILE_BYTES)]))
  vi.mocked(sandboxForRequest).mockResolvedValue({ readFile } as never)
  await errorResponse(await POST(request('POST', { paths: ['a.ts', 'b.ts', 'c.ts', 'd.ts'] }), context), 413, 'SNAPSHOT_TOO_LARGE')
  expect(readFile).toHaveBeenCalledTimes(3)
})

it.each([401, 403, 404, 410, 429])('preserves an ownership/lifecycle failure (%i) without reading files', async status => {
  vi.mocked(sandboxForRequest).mockRejectedValue(new ApiError(status, 'EXPECTED_FAILURE', 'Retry safely'))
  await errorResponse(await POST(request('POST', { paths: ['main.ts'] }), context), status, 'EXPECTED_FAILURE')
  await errorResponse(await PUT(request('PUT', { files: [] }), context), status, 'EXPECTED_FAILURE')
  expect(writeSandboxFilesForRequest).not.toHaveBeenCalled()
})

it('returns a bounded interrupted response and destroys a stalled stream', async () => {
  vi.useFakeTimers()
  const stream = new Readable({ read() {} })
  vi.mocked(sandboxForRequest).mockResolvedValue({ readFile: async () => stream } as never)
  const response = POST(request('POST', { paths: ['main.ts'] }), context)
  await vi.advanceTimersByTimeAsync(SANDBOX_FILE_READ_TIMEOUT_MS)
  await errorResponse(await response, 408, 'FILE_READ_INTERRUPTED')
  expect(stream.destroyed).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it('bounds a stalled restore body and performs no writes', async () => {
  vi.useFakeTimers()
  const cancel = vi.fn()
  const response = PUT(new Request('http://localhost/api/test', { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: new ReadableStream({ cancel }), duplex: 'half' } as RequestInit), context)
  await vi.advanceTimersByTimeAsync(REQUEST_BODY_TIMEOUT_MS)
  await errorResponse(await response, 408, 'REQUEST_INTERRUPTED')
  expect(cancel).toHaveBeenCalledOnce()
  expect(writeSandboxFilesForRequest).not.toHaveBeenCalled()
  expect(sandboxForRequest).not.toHaveBeenCalled()
})

it('rejects a declared oversize restore and a cancelled restore before external work', async () => {
  const oversized = request('PUT', { files: [] })
  oversized.headers.set('content-length', String(4 * 1024 * 1024 + 1))
  await errorResponse(await PUT(oversized, context), 413, 'REQUEST_TOO_LARGE')
  await errorResponse(await PUT(request('PUT', { files: [] }, AbortSignal.abort()), context), 408, 'REQUEST_INTERRUPTED')
  expect(writeSandboxFilesForRequest).not.toHaveBeenCalled()
  expect(sandboxForRequest).not.toHaveBeenCalled()
})

it('keeps restore revisions and returns a traceable receipt only after the write finishes', async () => {
  let finish!: () => void
  vi.mocked(writeSandboxFilesForRequest).mockImplementation(() => new Promise(resolve => { finish = () => resolve([]) }))
  const files = [{ path: 'main.ts', content: '🙂', revision: 2 }]
  const settled = vi.fn()
  const result = PUT(request('PUT', { files }), context).then(response => { settled(); return response })
  await vi.waitFor(() => expect(writeSandboxFilesForRequest).toHaveBeenCalledOnce())
  expect(settled).not.toHaveBeenCalled()
  finish()
  const response = await result
  expect(writeSandboxFilesForRequest).toHaveBeenCalledWith(expect.any(Request), 'sbx_owned', files)
  expect(await response.json()).toEqual({ restored: 1, totalBytes: 4, requestId: response.headers.get('x-request-id') })
})

it('does not return or log raw upstream source/provider errors', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    vi.mocked(sandboxForRequest).mockRejectedValue(new Error('private token and source'))
    const response = await POST(request('POST', { paths: ['main.ts'] }), context)
    await errorResponse(response, 502, 'SNAPSHOT_READ_FAILED')
    expect(JSON.stringify(log.mock.calls)).not.toContain('private token')
  } finally { log.mockRestore() }
})
