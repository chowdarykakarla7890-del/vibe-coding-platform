import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { POST } from '@/app/api/projects/[projectId]/archives/route'
import { GET, DELETE } from '@/app/api/projects/[projectId]/archives/[archiveId]/route'
import { GET as cleanupArchives } from '@/app/api/internal/archive-cleanup/route'
import { ApiError, requireOwnedProject, requireUser } from '@/lib/server/api'
import { createOwnedArchive, deleteOwnedArchive, readOwnedArchive } from '@/lib/server/project-archive'
import { consumeQuota } from '@/lib/server/rate-limit'

const purge = vi.hoisted(() => vi.fn())
vi.mock('server-only', () => ({}))
vi.mock('@/lib/server/api', async original => ({ ...await original<object>(), requireUser: vi.fn(), requireOwnedProject: vi.fn() }))
vi.mock('@/lib/server/project-archive', async original => ({ ...await original<object>(), createOwnedArchive: vi.fn(), deleteOwnedArchive: vi.fn(), readOwnedArchive: vi.fn() }))
vi.mock('@/lib/server/rate-limit', () => ({ consumeQuota: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createAdminSupabaseClient: () => ({ rpc: purge }) }))
const projectId = '11111111-1111-4111-8111-111111111111', archiveId = '22222222-2222-4222-8222-222222222222'
const context = { params: Promise.resolve({ projectId, archiveId }) }
const url = `http://localhost/api/projects/${projectId}/archives`
const auth = { user: { id: 'owner' } } as never
const post = (body: unknown, origin = 'http://localhost') => new Request(url, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) })
beforeEach(() => {
  vi.mocked(requireUser).mockResolvedValue(auth)
  vi.mocked(requireOwnedProject).mockResolvedValue({ id: projectId } as never)
  vi.mocked(consumeQuota).mockResolvedValue({ 'X-RateLimit-Limit': '3', 'X-RateLimit-Remaining': '2', 'X-RateLimit-Reset': '123' })
  vi.mocked(createOwnedArchive).mockResolvedValue({ id: archiveId, projectId, createdAt: new Date().toISOString(), expiresAt: new Date().toISOString(), recordCount: 1, payloadBytes: 10 })
  vi.mocked(readOwnedArchive).mockResolvedValue({ id: archiveId, records: [], nextCursor: null })
  vi.mocked(deleteOwnedArchive).mockResolvedValue({ deleted: true })
})
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs() })
it('uses trusted ownership, request IDs and private responses', async () => {
  const response = await POST(post({ archiveId }), context)
  expect(response.status).toBe(201)
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  expect(response.headers.get('X-RateLimit-Limit')).toBe('3')
  expect(response.headers.get('X-Request-Id')).toBeTruthy()
  expect(createOwnedArchive).toHaveBeenCalledWith(auth, projectId, archiveId, expect.any(AbortSignal))
})
it.each([{ archiveId: '../escape' }, { archiveId, userId: 'forged-owner' }, {}, { archiveId, catalog: [] }])('rejects invalid or injected export options', async body => {
  expect((await POST(post(body), context)).status).toBe(400)
  expect(createOwnedArchive).not.toHaveBeenCalled()
})
it('rejects malformed JSON and content type before creating an archive', async () => {
  expect((await POST(new Request(url, { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: '{' }), context)).status).toBe(400)
  expect((await POST(new Request(url, { method: 'POST', headers: { origin: 'http://localhost' }, body: '{}' }), context)).status).toBe(415)
})
it('denies unauthenticated, foreign project and cross-site creation', async () => {
  vi.mocked(requireUser).mockRejectedValueOnce(new ApiError(401, 'AUTH_REQUIRED', 'Sign in'))
  expect((await POST(post({ archiveId }), context)).status).toBe(401)
  vi.mocked(requireOwnedProject).mockRejectedValueOnce(new ApiError(404, 'PROJECT_NOT_FOUND', 'Project not found'))
  expect((await POST(post({ archiveId }), context)).status).toBe(404)
  expect((await POST(post({ archiveId }, 'https://other.example'), context)).status).toBe(403)
  expect(createOwnedArchive).not.toHaveBeenCalled()
})
it('preserves rate-limit failures without beginning export', async () => {
  vi.mocked(consumeQuota).mockRejectedValue(new ApiError(429, 'RATE_LIMITED', 'Wait', { 'Retry-After': '60' }))
  const response = await POST(post({ archiveId }), context)
  expect(response.status).toBe(429); expect(response.headers.get('Retry-After')).toBe('60')
  expect(createOwnedArchive).not.toHaveBeenCalled()
})
it.each(['-1', '50001', '1.5', '1e3', '01'])('rejects invalid page cursor %s', async after => {
  expect((await GET(new Request(`${url}/${archiveId}?after=${after}`), context)).status).toBe(400)
  expect(readOwnedArchive).not.toHaveBeenCalled()
})
it('reads exactly the owned export and distinguishes expiration', async () => {
  await GET(new Request(`${url}/${archiveId}?after=20`), context)
  expect(readOwnedArchive).toHaveBeenCalledWith(auth, projectId, archiveId, 20, expect.any(AbortSignal))
  vi.mocked(readOwnedArchive).mockRejectedValue(new ApiError(410, 'ARCHIVE_EXPIRED', 'Export expired'))
  expect((await GET(new Request(`${url}/${archiveId}`), context)).status).toBe(410)
})
it('cleanup requires origin and removes only an owned temporary archive', async () => {
  expect((await DELETE(new Request(`${url}/${archiveId}`, { method: 'DELETE' }), context)).status).toBe(403)
  expect(deleteOwnedArchive).not.toHaveBeenCalled()
  expect((await DELETE(new Request(`${url}/${archiveId}`, { method: 'DELETE', headers: { origin: 'http://localhost' } }), context)).status).toBe(200)
  expect(deleteOwnedArchive).toHaveBeenCalledWith(auth, projectId, archiveId, expect.any(AbortSignal))
})
it('protects periodic cleanup and validates its bounded result', async () => {
  vi.stubEnv('CRON_SECRET', '')
  expect((await cleanupArchives(new Request('http://localhost/api/internal/archive-cleanup'))).status).toBe(503)
  vi.stubEnv('CRON_SECRET', 'a'.repeat(40))
  expect((await cleanupArchives(new Request('http://localhost/api/internal/archive-cleanup'))).status).toBe(401)
  expect(purge).not.toHaveBeenCalled()
  purge.mockImplementation((name: string) => ({ abortSignal: vi.fn().mockResolvedValue({ data: name.startsWith('purge_') ? 1 : true, error: null }) }))
  const response = await cleanupArchives(new Request('http://localhost/api/internal/archive-cleanup', { headers: { authorization: `Bearer ${'a'.repeat(40)}` } }))
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ removed: 1, importsRemoved: 1, archiveImportsRemoved: 1 })
  expect(purge).toHaveBeenCalledWith('purge_project_archives')
  expect(purge).toHaveBeenCalledWith('purge_source_imports')
  expect(purge).toHaveBeenCalledWith('purge_project_archive_imports')
})
