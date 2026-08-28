import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { POST as begin } from '@/app/api/projects/archive-imports/route'
import { GET, PUT, POST, DELETE } from '@/app/api/projects/archive-imports/[importId]/route'
import { GET as history } from '@/app/api/projects/[projectId]/imported-archive/route'
import { ApiError, requireOwnedProject, requireUser } from '@/lib/server/api'
import { ownedArchiveImport, ownedImportedArchive } from '@/lib/server/archive-import'
import { consumeQuota } from '@/lib/server/rate-limit'
import { archiveFixture } from './fixtures/project-archive'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/server/api', async original => ({ ...await original<object>(), requireUser: vi.fn(), requireOwnedProject: vi.fn() }))
vi.mock('@/lib/server/archive-import', () => ({ ownedArchiveImport: vi.fn(), ownedImportedArchive: vi.fn() }))
vi.mock('@/lib/server/rate-limit', () => ({ consumeQuota: vi.fn() }))
const id = '33333333-3333-4333-8333-333333333333', auth = { user: { id: 'owner' } } as never
const context = { params: Promise.resolve({ importId: id }) }, projectContext = { params: Promise.resolve({ projectId: id }) }
let fixture: Awaited<ReturnType<typeof archiveFixture>>
const request = (method: string, body?: unknown, origin = 'http://localhost') => new Request(`http://localhost/api/projects/archive-imports/${id}`, { method, headers: { origin, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
beforeEach(async () => {
  fixture = await archiveFixture()
  vi.mocked(requireUser).mockResolvedValue(auth)
  vi.mocked(requireOwnedProject).mockResolvedValue({ id } as never)
  vi.mocked(consumeQuota).mockResolvedValue({ 'X-RateLimit-Limit': '120', 'X-RateLimit-Remaining': '119', 'X-RateLimit-Reset': '123' })
  vi.mocked(ownedArchiveImport).mockResolvedValue({ id, state: 'uploading' })
  vi.mocked(ownedImportedArchive).mockResolvedValue({ id, records: [] })
})
afterEach(() => vi.resetAllMocks())
it('uses the authenticated owner and private request-ID responses', async () => {
  const body = { id, manifest: fixture.manifest, digest: fixture.digest }
  const response = await begin(request('POST', body))
  expect(response.status).toBe(201); expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(response.headers.get('x-request-id')).toBeTruthy()
  expect(ownedArchiveImport).toHaveBeenCalledWith(auth, id, 'begin', { manifest: fixture.manifest, digest: fixture.digest }, expect.any(AbortSignal))
  expect((await PUT(request('PUT', { records: fixture.envelopes }), context)).status).toBe(200)
  expect(ownedArchiveImport).toHaveBeenLastCalledWith(auth, id, 'upload', { records: fixture.envelopes }, expect.any(AbortSignal))
})
it.each(['userId', 'sandboxId', 'projectId', 'score'])('rejects injected %s authority', async field => {
  expect((await begin(request('POST', { id, manifest: fixture.manifest, digest: fixture.digest, [field]: 'forged' }))).status).toBe(400)
  expect(ownedArchiveImport).not.toHaveBeenCalled()
})
it('rejects malformed input, unsafe source, altered digests and oversized bodies before storage', async () => {
  expect((await begin(new Request('http://localhost', { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: '{' }))).status).toBe(400)
  expect((await begin(new Request('http://localhost', { method: 'POST', headers: { origin: 'http://localhost' }, body: '{}' }))).status).toBe(415)
  expect((await PUT(request('PUT', { records: [{ ...fixture.envelopes[0], sha256: '0'.repeat(64) }] }), context)).status).toBe(400)
  const unsafe = await archiveFixture([JSON.parse(fixture.envelopes[0].record), { kind: 'source', key: '.env', data: { path: '.env', content: 'secret', revision: 1, deleted: false, updatedAt: '2026-08-01T00:00:00Z' } }])
  expect((await PUT(request('PUT', { records: unsafe.envelopes }), context)).status).toBe(400)
  expect((await PUT(request('PUT', { records: [{ ...fixture.envelopes[0], record: 'x'.repeat(5 * 1024 * 1024) }] }), context)).status).toBe(413)
  expect(ownedArchiveImport).not.toHaveBeenCalled()
})
it('requires authentication, same-origin mutations and valid route IDs', async () => {
  vi.mocked(requireUser).mockRejectedValueOnce(new ApiError(401, 'AUTH_REQUIRED', 'Sign in'))
  expect((await GET(request('GET'), context)).status).toBe(401)
  expect((await DELETE(request('DELETE', undefined, 'https://other.invalid'), context)).status).toBe(403)
  expect((await GET(request('GET'), { params: Promise.resolve({ importId: '../escape' }) })).status).toBe(400)
  expect(ownedArchiveImport).not.toHaveBeenCalled()
})
it('returns structured expired and quota failures and cancels only staging', async () => {
  await DELETE(request('DELETE'), context)
  expect(ownedArchiveImport).toHaveBeenCalledWith(auth, id, 'cancel', {}, expect.any(AbortSignal))
  vi.mocked(ownedArchiveImport).mockRejectedValueOnce(new ApiError(410, 'ARCHIVE_IMPORT_EXPIRED', 'Expired'))
  expect((await POST(request('POST', {}), context)).status).toBe(410)
  vi.mocked(consumeQuota).mockRejectedValue(new ApiError(429, 'RATE_LIMITED', 'Wait', { 'Retry-After': '60' }))
  const response = await GET(request('GET'), context)
  expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBe('60')
})
it.each(['after=-1', 'after=01', 'after=1e2', 'after=50001', 'after=1&after=2', 'userId=forged'])('rejects invalid history cursor %s', async query => {
  expect((await history(new Request(`http://localhost/api/projects/${id}/imported-archive?${query}`), projectContext)).status).toBe(400)
  expect(ownedImportedArchive).not.toHaveBeenCalled()
})
it('checks project ownership before looking up imported evidence', async () => {
  vi.mocked(requireOwnedProject).mockRejectedValueOnce(new ApiError(404, 'PROJECT_NOT_FOUND', 'Missing'))
  expect((await history(new Request('http://localhost'), projectContext)).status).toBe(404)
  expect(ownedImportedArchive).not.toHaveBeenCalled()
  expect((await history(new Request('http://localhost?after=20'), projectContext)).status).toBe(200)
  expect(ownedImportedArchive).toHaveBeenCalledWith(auth, id, 20, expect.any(AbortSignal))
})
