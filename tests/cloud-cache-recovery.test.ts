import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProject, removeProject, saveProject, setUserStorageScope } from '@/lib/learning/db'
import * as cache from '@/lib/learning/local-db'

vi.mock('@/lib/learning/local-db', () => ({
  setUserStorageScope: vi.fn(),
  saveProject: vi.fn(),
  removeProject: vi.fn(),
  parseStoredChatMessages: vi.fn(),
  parseProjectExport: vi.fn(),
}))

const project = {
  id: '550e8400-e29b-41d4-a716-446655440000', title: 'Saved project',
  mode: 'playground' as const, language: 'Any', status: 'active' as const,
  createdAt: 1, updatedAt: 1,
}
const row = {
  ...project, activity_id: null,
  created_at: '2026-08-27T00:00:00Z', updated_at: '2026-08-27T00:00:00Z',
  sandbox_sessions: [{
    sandbox_id: 'sbx_restored', status: 'running',
    expires_at: '2099-01-01T00:00:00Z', preview_origin: null,
  }],
}

beforeEach(() => setUserStorageScope('550e8400-e29b-41d4-a716-446655440001'))
afterEach(() => { setUserStorageScope(undefined); vi.unstubAllGlobals(); vi.resetAllMocks(); vi.useRealTimers() })

describe('nonblocking device cache after authoritative project saves', () => {
  it.each(['headers', 'body'] as const)('settles a stalled restoration save %s without caching a late receipt', async phase => {
    vi.useFakeTimers()
    let finish!: (value: unknown) => void
    let signal!: AbortSignal
    const delayed = new Promise(resolve => { finish = resolve })
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal
      return phase === 'headers' ? delayed : { ok: true, json: () => delayed }
    })
    vi.stubGlobal('fetch', fetcher)
    let outcome = 'pending'
    const result = saveProject(project).then(() => { outcome = 'saved' }, (error: Error) => { outcome = error.message })
    await vi.advanceTimersByTimeAsync(20_001)
    expect(outcome).toMatch(/timed out/i)
    expect(signal.aborted).toBe(true)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(cache.saveProject).not.toHaveBeenCalled()
    finish(phase === 'headers' ? Response.json({ project: row }) : { project: row })
    await result
    await vi.advanceTimersByTimeAsync(0)
    expect(cache.saveProject).not.toHaveBeenCalled()
  })

  it.each(['create', 'restore', 'delete'] as const)('%s settles even if IndexedDB never opens', async (action) => {
    vi.mocked(cache.saveProject).mockReturnValue(new Promise(() => {}))
    vi.mocked(cache.removeProject).mockReturnValue(new Promise(() => {}))
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(action === 'delete' ? { deleted: true } : { project: row })))
    const result = action === 'create' ? createProject(project)
      : action === 'restore' ? saveProject({ ...project, sandboxId: 'sbx_restored' })
        : removeProject(project.id)
    if (action === 'delete') await expect(result).resolves.toBeUndefined()
    else await expect(result).resolves.toMatchObject({ id: project.id, sandboxId: 'sbx_restored' })
    expect(action === 'delete' ? cache.removeProject : cache.saveProject).toHaveBeenCalledOnce()
  }, 500)

  it('observes a late cache failure without undoing the restored sandbox', async () => {
    let rejectCache!: (error: Error) => void
    vi.mocked(cache.saveProject).mockReturnValue(new Promise((_, reject) => { rejectCache = reject }))
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ project: row })))
    await expect(saveProject(project)).resolves.toMatchObject({ sandboxId: 'sbx_restored' })
    rejectCache(new DOMException('Browser storage unavailable', 'SecurityError'))
    await Promise.resolve()
  }, 500)

  it('still waits for the authoritative save and never caches a failed mutation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { message: 'Project save failed.' } }, { status: 502 })))
    await expect(saveProject(project)).rejects.toThrow('Project save failed.')
    expect(cache.saveProject).not.toHaveBeenCalled()
  })
})
