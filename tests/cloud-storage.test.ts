import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { cloudOperation, setCloudAccount } from '@/lib/learning/cloud-request'
import { listFileSnapshots, listProjects, saveFileSnapshots, setUserStorageScope } from '@/lib/learning/db'
import { projectRowSchema } from '@/lib/projects/serialization'

afterEach(() => { setUserStorageScope(undefined); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('account-owned cloud storage', () => {
  it('never starts storage requests while signed out', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    await expect(listProjects()).rejects.toThrow(/Sign in/)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('aborts pending work and rejects late responses after an account change', async () => {
    const first = crypto.randomUUID()
    setCloudAccount(first)
    let finish!: (response: Response) => void
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve }))
    vi.stubGlobal('fetch', fetcher)
    const operation = cloudOperation()
    const result = expect(operation.request('/api/projects', z.object({ projects: z.array(z.unknown()) }))).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    setCloudAccount(crypto.randomUUID())
    finish(Response.json({ projects: [] }))
    await result
    const options = (fetcher.mock.calls as unknown as [string, RequestInit][])[0][1]
    expect(options.signal?.aborted).toBe(true)
    expect(options.headers).toMatchObject({ 'X-CodeTutor-Account': first })
    expect(() => operation.assertActive()).toThrow()
  })

  it('rejects malformed successful responses rather than treating them as empty data', async () => {
    setCloudAccount(crypto.randomUUID())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ files: 'broken' })))
    await expect(listFileSnapshots(crypto.randomUUID())).rejects.toThrow(/invalid response/)
  })

  it('maps server-owned fields and ignores forged sandbox context', () => {
    const project = projectRowSchema.parse({ id: crypto.randomUUID(), title: 'My project', mode: 'playground', language: 'Any', status: 'active', activity_id: null,
      created_at: '2026-08-27T00:00:00+00:00', updated_at: '2026-08-27T00:00:00+00:00', sandboxId: 'forged' })
    expect(project.sandboxId).toBeUndefined()
    expect(project.createdAt).toBe(Date.parse('2026-08-27T00:00:00Z'))
  })

  it('batches source saves within the request limit and deduplicates paths', async () => {
    setCloudAccount(crypto.randomUUID())
    const files = Array.from({ length: 12 }, (_, index) => ({ path: `src/${index}.txt`, content: '\n'.repeat(256 * 1024) }))
    const uploads: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
      expect(new TextEncoder().encode(String(options.body)).length).toBeLessThan(2 * 1024 * 1024 + 1024)
      const batch = JSON.parse(String(options.body)).files
      uploads.push(...batch)
      return Response.json({ saved: batch.length })
    }))
    await expect(saveFileSnapshots(crypto.randomUUID(), [...files, files[0]])).resolves.toBe(12)
    expect(uploads).toEqual(files)
  })

  it('requires a receipt for every file and surfaces authorization errors', async () => {
    setCloudAccount(crypto.randomUUID())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ saved: 0 }))
      .mockResolvedValueOnce(Response.json({ error: { message: 'Sign in to continue.' } }, { status: 401 })))
    await expect(saveFileSnapshots(crypto.randomUUID(), [{ path: 'file.ts', content: 'ok' }])).rejects.toThrow(/acknowledge/)
    await expect(listProjects()).rejects.toThrow('Sign in to continue.')
  })

  it('assembles paginated files and detects repeated cursors', async () => {
    setCloudAccount(crypto.randomUUID())
    const file = { path: 'a.ts', content: 'ok', updatedAt: 1, revision: 1 }
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ files: [file], nextCursor: 'a.ts' }))
      .mockResolvedValueOnce(Response.json({ files: [{ ...file, path: 'b.ts' }], nextCursor: null }))
      .mockImplementation(async () => Response.json({ files: [file], nextCursor: 'a.ts' }))
    vi.stubGlobal('fetch', fetcher)
    const id = crypto.randomUUID()
    expect((await listFileSnapshots(id)).map((item) => item.path)).toEqual(['a.ts', 'b.ts'])
    expect(fetcher.mock.calls[1][0]).toContain('?after=a.ts')
    await expect(listFileSnapshots(id)).rejects.toThrow(/pagination/)
  })

  it('stops obsolete source pagination without cancelling another read for the same account', async () => {
    setCloudAccount(crypto.randomUUID())
    const controller = new AbortController()
    let finish!: (response: Response) => void
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve }))
      .mockResolvedValueOnce(Response.json({ projects: [], nextCursor: null }))
    vi.stubGlobal('fetch', fetcher)
    const result = expect(listFileSnapshots(crypto.randomUUID(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    controller.abort()
    finish(Response.json({ files: [{ path: 'a.ts', content: 'saved', updatedAt: 1, revision: 1 }], nextCursor: 'a.ts' }))
    await result
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await expect(listProjects()).resolves.toEqual([])
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('does not fetch source for an already cancelled recovery', async () => {
    setCloudAccount(crypto.randomUUID())
    const controller = new AbortController()
    controller.abort()
    const fetcher = vi.fn().mockResolvedValue(Response.json({ files: [], nextCursor: null }))
    vi.stubGlobal('fetch', fetcher)
    await expect(listFileSnapshots(crypto.randomUUID(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each(['headers', 'body'] as const)('bounds stalled project read %s without converting it into empty data or retrying', async phase => {
    vi.useFakeTimers()
    setCloudAccount(crypto.randomUUID())
    let signal!: AbortSignal
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal
      return phase === 'headers' ? new Promise(() => {}) : { ok: true, json: () => new Promise(() => {}) }
    })
    vi.stubGlobal('fetch', fetcher)
    let outcome = 'pending'
    const result = listProjects().then(() => { outcome = 'resolved' }, (error: Error) => { outcome = error.message })
    await vi.advanceTimersByTimeAsync(20_001)
    expect(outcome).toMatch(/timed out/)
    await result
    expect(signal.aborted).toBe(true)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it.each(['GET', 'PATCH'] as const)('settles an aborted %s body and ignores its late receipt', async method => {
    setCloudAccount(crypto.randomUUID())
    let finish!: (value: unknown) => void
    const json = vi.fn(() => new Promise(resolve => { finish = resolve }))
    const fetcher = vi.fn(async () => ({ ok: true, json }))
    vi.stubGlobal('fetch', fetcher)
    const controller = new AbortController()
    const result = expect(cloudOperation(controller.signal).request('/api/projects', z.object({ saved: z.literal(true) }), method)).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(json).toHaveBeenCalledOnce())
    controller.abort()
    await result
    finish({ saved: true })
    await Promise.resolve()
    expect(fetcher).toHaveBeenCalledOnce()
  })
})
