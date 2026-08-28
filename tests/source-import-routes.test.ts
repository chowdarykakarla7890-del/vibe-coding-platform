import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { POST as begin } from '@/app/api/projects/imports/route'
import { GET, PUT, POST, DELETE } from '@/app/api/projects/imports/[importId]/route'
import { ApiError, requireUser } from '@/lib/server/api'
import { ownedSourceImport } from '@/lib/server/source-import'
import { consumeQuota } from '@/lib/server/rate-limit'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/server/api', async original => ({ ...await original<object>(), requireUser: vi.fn() }))
vi.mock('@/lib/server/source-import', () => ({ ownedSourceImport: vi.fn() }))
vi.mock('@/lib/server/rate-limit', () => ({ consumeQuota: vi.fn() }))
const id = '11111111-1111-4111-8111-111111111111', auth = { user: { id: 'owner' } } as never
const context = { params: Promise.resolve({ importId: id }) }
const payload = { id, title: 'Import fixture', language: 'TypeScript', fileCount: 0, sourceBytes: 0, digest: 'a'.repeat(64) }
function request(method: string, body?: unknown, origin = 'http://localhost') {
  return new Request(`http://localhost/api/projects/imports/${id}`, { method, headers: { origin, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
beforeEach(() => {
  vi.mocked(requireUser).mockResolvedValue(auth)
  vi.mocked(consumeQuota).mockResolvedValue({ 'X-RateLimit-Limit': '120', 'X-RateLimit-Remaining': '119', 'X-RateLimit-Reset': '123' })
  vi.mocked(ownedSourceImport).mockResolvedValue({ id, state: 'uploading' })
})
afterEach(() => vi.resetAllMocks())
it('uses the authenticated account, strict schema and private structured receipts', async () => {
  const response = await begin(request('POST', payload))
  expect(response.status).toBe(201)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(response.headers.get('x-request-id')).toBeTruthy()
  const metadata = { title: payload.title, language: payload.language, fileCount: payload.fileCount, sourceBytes: payload.sourceBytes, digest: payload.digest }
  expect(ownedSourceImport).toHaveBeenCalledWith(auth, id, 'begin', metadata, expect.any(AbortSignal))
})
it.each(['userId', 'sandboxId', 'messages', 'score', 'status', 'activityId'])('rejects injected %s authority before calling the database', async field => {
  expect((await begin(request('POST', { ...payload, [field]: 'forged' }))).status).toBe(400)
  expect(ownedSourceImport).not.toHaveBeenCalled()
})
it('rejects malformed JSON, content types, oversized bodies, unsafe paths and null bytes', async () => {
  expect((await begin(new Request('http://localhost/api/projects/imports', { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: '{' }))).status).toBe(400)
  expect((await begin(new Request('http://localhost/api/projects/imports', { method: 'POST', headers: { origin: 'http://localhost' }, body: '{}' }))).status).toBe(415)
  for (const file of [{ path: '../escape', content: 'x' }, { path: 'main.ts', content: '\0' }, { path: 'main.ts', content: 'x', userId: 'forged' }]) {
    expect((await PUT(request('PUT', { files: [{ ...file, digest: 'a'.repeat(64) }] }), context)).status).toBe(400)
  }
  expect((await PUT(request('PUT', { files: [{ path: 'main.ts', content: 'x'.repeat(2 * 1024 * 1024), digest: 'a'.repeat(64) }] }), context)).status).toBe(413)
  expect(ownedSourceImport).not.toHaveBeenCalled()
})
it('denies unauthenticated access, CSRF and invalid IDs', async () => {
  vi.mocked(requireUser).mockRejectedValueOnce(new ApiError(401, 'AUTH_REQUIRED', 'Sign in'))
  expect((await GET(request('GET'), context)).status).toBe(401)
  expect((await begin(request('POST', payload, 'https://other.invalid'))).status).toBe(403)
  expect((await DELETE(request('DELETE', undefined, 'https://other.invalid'), context)).status).toBe(403)
  expect((await GET(request('GET'), { params: Promise.resolve({ importId: '../escape' }) })).status).toBe(400)
  expect(ownedSourceImport).not.toHaveBeenCalled()
})
it('surfaces missing, expired and quota failures and routes cancellation only to staging', async () => {
  await DELETE(request('DELETE'), context)
  expect(ownedSourceImport).toHaveBeenCalledWith(auth, id, 'cancel', {}, expect.any(AbortSignal))
  vi.mocked(ownedSourceImport).mockRejectedValueOnce(new ApiError(404, 'IMPORT_NOT_FOUND', 'Import not found'))
  expect((await GET(request('GET'), context)).status).toBe(404)
  vi.mocked(ownedSourceImport).mockRejectedValueOnce(new ApiError(410, 'IMPORT_EXPIRED', 'Import expired'))
  expect((await POST(request('POST', {}), context)).status).toBe(410)
  vi.mocked(consumeQuota).mockRejectedValue(new ApiError(429, 'RATE_LIMITED', 'Wait', { 'Retry-After': '60' }))
  const response = await GET(request('GET'), context)
  expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBe('60')
})
