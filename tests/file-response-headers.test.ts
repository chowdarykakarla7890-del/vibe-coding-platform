import { afterEach, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET, POST, PUT } from '@/app/api/sandboxes/[sandboxId]/files/route'
import { writeSandboxFilesForRequest } from '@/lib/server/source-files'
import { sandboxForRequest } from '@/lib/server/sandbox'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/server/source-files', () => ({ writeSandboxFilesForRequest: vi.fn() }))
vi.mock('@/lib/server/sandbox', () => ({ sandboxForRequest: vi.fn(), getOwnedSandbox: vi.fn() }))
afterEach(() => vi.resetAllMocks())
const context = { params: Promise.resolve({ sandboxId: 'sbx_owned' }) }
const request = (method: string, body: unknown, contentType = 'application/json') => new NextRequest('http://localhost/api/test', {
  method, headers: { origin: 'http://localhost', 'content-type': contentType }, body: typeof body === 'string' ? body : JSON.stringify(body),
})
async function headers(response: Response, status: number) {
  expect(response.status).toBe(status)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  const value = await response.json()
  expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
  expect(response.headers.get('x-request-id')).toBe(value.error?.requestId ?? value.requestId)
}
it('returns traceable noncacheable file save and create receipts', async () => {
  vi.mocked(writeSandboxFilesForRequest).mockResolvedValue([{ path: 'main.ts', revision: 2 }])
  await headers(await PUT(request('PUT', { path: 'main.ts', content: 'saved', revision: 1 }), context), 200)
  await headers(await POST(request('POST', { path: 'main.ts', type: 'file' }), context), 200)
  vi.mocked(sandboxForRequest).mockResolvedValue({ mkDir: vi.fn() } as never)
  await headers(await POST(request('POST', { path: 'src', type: 'folder' }), context), 200)
})
it('returns the same headers for invalid paths and malformed mutation bodies', async () => {
  await headers(await GET(new NextRequest('http://localhost/api/test?path=../private'), context), 400)
  for (const [method, handler] of [['PUT', PUT], ['POST', POST]] as const) {
    await headers(await handler(request(method, '{'), context), 400)
    await headers(await handler(request(method, {}, 'text/plain'), context), 415)
  }
  expect(writeSandboxFilesForRequest).not.toHaveBeenCalled()
  expect(sandboxForRequest).not.toHaveBeenCalled()
})
it('redacts upstream failures while keeping their request IDs', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    vi.mocked(writeSandboxFilesForRequest).mockRejectedValue(new Error('private source and token'))
    const response = await PUT(request('PUT', { path: 'main.ts', content: 'saved' }), context)
    expect(await response.clone().text()).not.toContain('private source')
    await headers(response, 502)
    expect(log).toHaveBeenCalledWith('Sandbox file save failed', expect.objectContaining({ requestId: expect.any(String), errorName: 'Error' }))
  } finally { log.mockRestore() }
})
