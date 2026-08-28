import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sandbox } from '@vercel/sandbox'
import { readOwnedSandboxPreview, connectOwnedSandboxPreview } from '@/lib/server/sandbox'
import { ApiError, requireOwnedSandbox, type AuthContext } from '@/lib/server/api'
import { previewOriginSchema } from '@/lib/sandbox/preview'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/server/sandbox-cleanup-dispatch', () => ({ scheduleSandboxCleanup: vi.fn() }))
vi.mock('@/lib/server/rate-limit', () => ({ consumeQuota: vi.fn() }))
vi.mock('@/ai/sandbox', async original => ({ ...await original<typeof import('@/ai/sandbox')>(), getSandboxCredentials: () => ({}) }))
vi.mock('@/lib/server/api', async original => ({ ...await original<typeof import('@/lib/server/api')>(), requireOwnedSandbox: vi.fn() }))
const db = vi.hoisted(() => ({ update: vi.fn(), eq: vi.fn(), abortSignal: vi.fn(), select: vi.fn(), maybeSingle: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createAdminSupabaseClient: () => ({ from: () => db }) }))
const projectId = '11111111-1111-4111-8111-111111111111'
const auth = { user: { id: 'owner' } } as AuthContext
const registration = { project_id: projectId, ports: [3000, 8000], preview_origin: 'https://sb-second.vercel.run' }
beforeEach(() => {
  for (const fn of [db.update, db.eq, db.abortSignal, db.select]) fn.mockReturnValue(db)
  db.maybeSingle.mockResolvedValue({ data: { id: 'record' }, error: null })
  vi.mocked(requireOwnedSandbox).mockResolvedValue(registration as never)
  vi.spyOn(Sandbox, 'get').mockResolvedValue({ currentSession: () => ({ status: 'running', domain: (port: number) => port === 3000 ? 'https://sb-first.vercel.run' : 'https://sb-second.vercel.run' }) } as never)
})
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); vi.useRealTimers() })

describe('owned preview resolution', () => {
  it('resolves only current SDK domains, retaining a saved exposed-port selection', async () => {
    expect(await readOwnedSandboxPreview(auth, 'owned', projectId)).toEqual({ projectId, sandboxId: 'owned', port: 8000, ports: [3000, 8000], url: 'https://sb-second.vercel.run' })
    expect(Sandbox.get).toHaveBeenCalledWith(expect.objectContaining({ name: 'owned', resume: false }))
    expect(db.update).not.toHaveBeenCalled()
  })
  it('ignores a forged cached origin and selects a verified default', async () => {
    vi.mocked(requireOwnedSandbox).mockResolvedValue({ ...registration, preview_origin: 'https://evil.vercel.run' } as never)
    expect(await readOwnedSandboxPreview(auth, 'owned', projectId)).toMatchObject({ port: 3000, url: 'https://sb-first.vercel.run' })
  })
  it('rejects another project before touching the provider', async () => {
    await expect(readOwnedSandboxPreview(auth, 'owned', '22222222-2222-4222-8222-222222222222')).rejects.toMatchObject({ status: 404 })
    expect(Sandbox.get).not.toHaveBeenCalled()
  })
  it('rejects a different user at the ownership boundary', async () => {
    vi.mocked(requireOwnedSandbox).mockRejectedValue(new ApiError(404, 'SANDBOX_NOT_FOUND', 'Not found.'))
    await expect(readOwnedSandboxPreview(auth, 'owned', projectId)).rejects.toMatchObject({ status: 404 })
    expect(Sandbox.get).not.toHaveBeenCalled()
  })
  it('rejects an unexposed port before provider access', async () => {
    await expect(readOwnedSandboxPreview(auth, 'owned', projectId, 9000)).rejects.toMatchObject({ code: 'PORT_NOT_EXPOSED' })
    expect(Sandbox.get).not.toHaveBeenCalled()
  })
  it.each(['https://evil.example', 'https://evil.vercel.run.example', 'https://user:pass@sb-owned.vercel.run', 'https://sb-owned.vercel.run:8443', 'https://nested.sb-owned.vercel.run', 'https://sb-owned.vercel.run/path', 'https://sb-owned.vercel.run?token=secret', 'http://sb-owned.vercel.run'])('rejects unsafe origin %s', async origin => {
    expect(previewOriginSchema.safeParse(origin).success).toBe(false)
    vi.mocked(Sandbox.get).mockResolvedValue({ currentSession: () => ({ status: 'running', domain: () => origin }) } as never)
    await expect(readOwnedSandboxPreview(auth, 'owned', projectId)).rejects.toMatchObject({ code: 'INVALID_PREVIEW_ORIGIN' })
    expect(db.update).not.toHaveBeenCalled()
  })
  it('updates only a running registration belonging to this project and user', async () => {
    expect(await connectOwnedSandboxPreview(auth, 'owned', projectId, 3000)).toMatchObject({ url: 'https://sb-first.vercel.run' })
    expect(db.eq.mock.calls).toEqual([['sandbox_id', 'owned'], ['project_id', projectId], ['user_id', 'owner'], ['status', 'running']])
    expect(db.update).toHaveBeenCalledWith(expect.objectContaining({ preview_origin: 'https://sb-first.vercel.run' }))
  })
  it('does not invent a successful connection if shutdown wins the update race', async () => {
    db.maybeSingle.mockResolvedValue({ data: null, error: null })
    await expect(connectOwnedSandboxPreview(auth, 'owned', projectId, 3000)).rejects.toMatchObject({ status: 410 })
  })
  it('cancels stale ownership reads without starting provider work', async () => {
    const controller = new AbortController()
    vi.mocked(requireOwnedSandbox).mockImplementation(async () => { controller.abort(); return registration as never })
    await expect(readOwnedSandboxPreview(auth, 'owned', projectId, undefined, controller.signal)).rejects.toBeTruthy()
    expect(Sandbox.get).not.toHaveBeenCalled()
  })
})
