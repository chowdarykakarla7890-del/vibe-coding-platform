import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_RESTORE_REQUEST_BYTES, readSandboxStatus, restoreProjectSandbox, startProjectSandbox } from '@/lib/learning/sandbox-recovery'
import { mapDataToState, useSandboxStore } from '@/app/state'
import { setCloudAccount } from '@/lib/learning/cloud-request'

const files = [{ path: 'app/page.tsx', content: 'export default function Page() {}' }]
const json = (body: unknown, status = 200) => Response.json(body, { status })

beforeEach(() => setCloudAccount(crypto.randomUUID()))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  useSandboxStore.getState().clearSandbox()
  setCloudAccount(undefined)
})

describe('manual workspace startup', () => {
  it('creates an empty sandbox directly without an AI or empty snapshot request', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ sandboxId: 'sbx_manual' }))
    vi.stubGlobal('fetch', fetcher)
    const projectId = crypto.randomUUID(), commit = vi.fn()
    const result = await startProjectSandbox({ projectId, signal: new AbortController().signal, loadFiles: async () => [], commit })
    expect(result).toEqual({ sandboxId: 'sbx_manual', files: [] })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0][0]).toBe('/api/sandboxes')
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ projectId, ports: [3000] })
    expect(commit).toHaveBeenCalledExactlyOnceWith('sbx_manual')
  })

  it('restores existing saved source before publishing a manually started workspace', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ sandboxId: 'sbx_manual' })).mockResolvedValueOnce(json({ restored: 1 }))
    vi.stubGlobal('fetch', fetcher)
    const commit = vi.fn(() => {
      expect(fetcher).toHaveBeenCalledTimes(2)
      return Promise.resolve()
    })
    await startProjectSandbox({ projectId: crypto.randomUUID(), signal: new AbortController().signal, loadFiles: async () => files, commit })
    expect(fetcher.mock.calls[1][0]).toBe('/api/sandboxes/sbx_manual/snapshot')
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ files })
    expect(commit).toHaveBeenCalledOnce()
  })

  it('never treats an unavailable or invalid saved-source read as a blank project', async () => {
    const fetcher = vi.fn(), commit = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    for (const loadFiles of [async () => undefined, async () => [{ path: '../secret', content: 'invalid' }], async () => { throw new Error('Source unavailable') }]) {
      await expect(startProjectSandbox({ projectId: crypto.randomUUID(), signal: new AbortController().signal, loadFiles, commit })).rejects.toThrow()
    }
    expect(fetcher).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
  })
})

describe('sandbox status', () => {
  it.each([
    ['stopped', 'running'],
    ['stopped', 'stopping'],
    ['stopping', 'running'],
  ] as const)('does not regress %s to %s after a delayed lifecycle response', (currentStatus, staleStatus) => {
    const store = useSandboxStore.getState()
    store.setSandboxId('sbx_old')
    store.addPaths(['app/page.tsx'])
    store.setDirtyFilePath('app/page.tsx')
    store.setSandboxStatus('sbx_old', currentStatus)
    const listener = vi.fn()
    const unsubscribe = useSandboxStore.subscribe(listener)
    try {
      store.setSandboxStatus('sbx_old', staleStatus)
      store.setUrl('https://old.vercel.run', 'late-preview')
      expect(useSandboxStore.getState()).toMatchObject({ status: currentStatus, url: undefined, paths: ['app/page.tsx'], dirtyFilePath: 'app/page.tsx' })
      expect(listener).not.toHaveBeenCalled()
      // A replacement is a different VM and may legitimately start running.
      store.setSandboxId('sbx_new')
      expect(useSandboxStore.getState()).toMatchObject({ sandboxId: 'sbx_new', status: 'running' })
    } finally {
      unsubscribe()
    }
  })

  it('does not reset files or revive an expired sandbox on duplicate creation events', () => {
    const store = useSandboxStore.getState()
    store.setSandboxId('sbx_old')
    store.addPaths(['app/page.tsx'])
    store.setSandboxStatus('sbx_old', 'stopped')
    const listener = vi.fn()
    const unsubscribe = useSandboxStore.subscribe(listener)
    mapDataToState({ type: 'data-create-sandbox', data: { sandboxId: 'sbx_old', status: 'done' } })
    store.addPaths(['app/page.tsx'])
    expect(useSandboxStore.getState()).toMatchObject({ status: 'stopped', paths: ['app/page.tsx'] })
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('stops active commands and clears an expired preview without removing file paths', () => {
    const store = useSandboxStore.getState()
    store.setSandboxId('sbx_old')
    store.addPaths(['app/page.tsx'])
    store.setUrl('https://old.vercel.run', 'preview')
    store.upsertCommand({ sandboxId: 'sbx_old', cmdId: 'cmd_1', command: 'npm', args: ['run', 'dev'], status: 'running' })
    store.setSandboxStatus('sbx_old', 'stopped')
    expect(useSandboxStore.getState()).toMatchObject({ status: 'stopped', url: undefined, urlUUID: undefined, paths: ['app/page.tsx'], commands: [{ status: 'error' }] })
    store.setUrl('https://old.vercel.run', 'late-preview')
    expect(useSandboxStore.getState().url).toBeUndefined()
  })

  it('ignores old file/command/log callbacks after attaching a replacement', () => {
    const store = useSandboxStore.getState()
    store.setSandboxId('sbx_new')
    store.upsertCommand({ sandboxId: 'sbx_new', cmdId: 'cmd_1', command: 'node', args: [], status: 'running' })
    mapDataToState({ type: 'data-generating-files', data: { sandboxId: 'sbx_old', paths: ['old.ts'], status: 'done' } })
    store.upsertCommand({ sandboxId: 'sbx_old', cmdId: 'cmd_1', command: 'old', args: [], status: 'error' })
    store.addLog({ sandboxId: 'sbx_old', cmdId: 'cmd_1', log: { data: 'late', stream: 'stdout', timestamp: 1 } })
    expect(useSandboxStore.getState()).toMatchObject({ paths: [], commands: [{ command: 'node', status: 'running', logs: [] }] })
  })
  it('treats 410 expiration as stopped without parsing an error page', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 410 })))
    await expect(readSandboxStatus('sbx_old', new AbortController().signal)).resolves.toBe('stopped')
  })

  it('does not publish expiration after the caller cancels the status check', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => {
      controller.abort()
      return new Response('', { status: 410 })
    }))
    await expect(readSandboxStatus('sbx_old', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('settles a stalled response body and cancels its request before retrying', async () => {
    vi.useFakeTimers()
    try {
      let requestSignal: AbortSignal | undefined
      const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
        requestSignal = init.signal as AbortSignal
        return { ok: true, status: 200, json: () => new Promise(() => {}) }
      })
      vi.stubGlobal('fetch', fetcher)
      let outcome = 'pending'
      const check = readSandboxStatus('sbx_old', new AbortController().signal)
        .then(() => { outcome = 'resolved' }, (error: Error) => { outcome = error.message })
      await vi.advanceTimersByTimeAsync(10_001)
      // Assert before awaiting so a broken deadline fails instead of hanging.
      expect(outcome).toMatch(/timed out/i)
      await check
      expect(requestSignal?.aborted).toBe(true)
      expect(fetcher).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects empty, invalid, and upstream failure responses safely', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(json({ status: 'unknown' }))
      .mockResolvedValueOnce(new Response('<html>private error</html>', { status: 502 }))
    vi.stubGlobal('fetch', fetcher)
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(readSandboxStatus('sbx_old', new AbortController().signal)).rejects.toThrow(/status/)
    }
  })

  it('ignores late status results from a previous sandbox and duplicate updates', () => {
    const store = useSandboxStore.getState()
    store.setSandboxId('sbx_new')
    const listener = vi.fn()
    const unsubscribe = useSandboxStore.subscribe(listener)
    store.setSandboxStatus('sbx_old', 'stopped')
    store.setSandboxStatus('sbx_new', 'running')
    expect(listener).not.toHaveBeenCalled()
    store.setSandboxStatus('sbx_new', 'stopped')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(useSandboxStore.getState().status).toBe('stopped')
    unsubscribe()
  })
})

describe('sandbox restoration', () => {
  it.each([
    ['restore', restoreProjectSandbox],
    ['start', startProjectSandbox],
  ] as const)('rejects non-text saved source before %s creates a replacement', async (_mode, provision) => {
    const fetcher = vi.fn(async () => json({ sandboxId: 'sbx_new', restored: 2 }))
    vi.stubGlobal('fetch', fetcher)
    const commit = vi.fn(), beforeCreate = vi.fn()
    const stored = [...files, { path: 'src/damaged.txt', content: 'before\0after' }]
    await expect(provision({
      projectId: crypto.randomUUID(), signal: new AbortController().signal,
      loadFiles: async () => stored, commit, beforeCreate,
    })).rejects.toThrow(/snapshot could not be validated/)
    expect(fetcher).not.toHaveBeenCalled()
    expect(beforeCreate).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
    expect(stored[1].content).toBe('before\0after')
  })

  it.each([
    ['restore', 'resolve', restoreProjectSandbox],
    ['restore', 'reject', restoreProjectSandbox],
    ['start', 'resolve', startProjectSandbox],
    ['start', 'reject', startProjectSandbox],
  ] as const)('settles a stalled %s association without stopping restored files or accepting a late %s receipt', async (_mode, outcome, provision) => {
    vi.useFakeTimers()
    let resolveSave!: () => void
    let rejectSave!: (reason: Error) => void
    const commit = vi.fn(() => new Promise<void>((resolve, reject) => {
      resolveSave = resolve
      rejectSave = reject
    }))
    const success = vi.fn(), failure = vi.fn()
    const fetcher = vi.fn().mockResolvedValueOnce(json({ sandboxId: 'sbx_new' }))
      .mockResolvedValueOnce(json({ restored: 1 }))
    vi.stubGlobal('fetch', fetcher)
    const result = provision({ projectId: crypto.randomUUID(), signal: new AbortController().signal, loadFiles: async () => files, commit })
      .then(success, failure)
    try {
      await vi.waitFor(() => expect(commit).toHaveBeenCalledExactlyOnceWith('sbx_new'))
      await vi.advanceTimersByTimeAsync(20_001)
      expect(failure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'SandboxReopenRequiredError' }))
      expect(success).not.toHaveBeenCalled()
      // Missing confirmation is not permission to destroy a restored VM.
      expect(fetcher).toHaveBeenCalledTimes(2)
      if (outcome === 'resolve') resolveSave()
      else rejectSave(new Error('Late save failure'))
      await vi.advanceTimersByTimeAsync(0)
      await result
      expect(success).not.toHaveBeenCalled()
      expect(failure).toHaveBeenCalledOnce()
      expect(fetcher).toHaveBeenCalledTimes(2)
    } finally {
      resolveSave?.()
      await result
      vi.useRealTimers()
    }
  })

  it('settles cancellation even when replacement shutdown ignores its abort signal', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    let finishCleanup!: (response: Response) => void
    let cleanupSignal: AbortSignal | undefined
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === 'POST') return json({ sandboxId: 'sbx_new' })
      if (init.method === 'DELETE') {
        cleanupSignal = init.signal as AbortSignal
        return new Promise<Response>((resolve) => { finishCleanup = resolve })
      }
      controller.abort()
      throw controller.signal.reason
    })
    vi.stubGlobal('fetch', fetcher)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const commit = vi.fn()
    let outcome = 'pending'
    const restore = restoreProjectSandbox({ projectId: crypto.randomUUID(), signal: controller.signal, loadFiles: async () => files, commit })
      .then(() => { outcome = 'resolved' }, (error: Error) => { outcome = error.name })
    try {
      await vi.advanceTimersByTimeAsync(5_001)
      expect(outcome).toBe('AbortError')
      expect(cleanupSignal?.aborted).toBe(true)
      expect(commit).not.toHaveBeenCalled()
      expect(fetcher.mock.calls.filter(([, init]) => init.method === 'DELETE')).toHaveLength(1)
    } finally {
      finishCleanup?.(json({ status: 'stopped' }))
      await restore
      vi.useRealTimers()
    }
  })

  it.each(['creation', 'upload'] as const)('cancels while the %s response body is stalled without committing', async (phase) => {
    const controller = new AbortController()
    let readingBody!: () => void
    const bodyStarted = new Promise<void>((resolve) => { readingBody = resolve })
    let finishBody!: (value: unknown) => void
    const delayedBody = new Promise<unknown>((resolve) => { finishBody = resolve })
    const stalledResponse = { ok: true, json: () => { readingBody(); return delayedBody } }
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === 'DELETE') return json({ stopped: true })
      if (init.method === 'POST') return phase === 'creation' ? stalledResponse : json({ sandboxId: 'sbx_new' })
      return stalledResponse
    })
    vi.stubGlobal('fetch', fetcher)
    const commit = vi.fn()
    let outcome = 'pending'
    const result = restoreProjectSandbox({ projectId: crypto.randomUUID(), signal: controller.signal, loadFiles: async () => files, commit })
      .then(() => { outcome = 'resolved' }, (error: Error) => { outcome = error.name })
    await bodyStarted
    controller.abort()
    try {
      await vi.waitFor(() => expect(outcome).toBe('AbortError'), { timeout: 100 })
      expect(commit).not.toHaveBeenCalled()
      if (phase === 'upload') expect(fetcher).toHaveBeenLastCalledWith('/api/sandboxes/sbx_new', expect.objectContaining({ method: 'DELETE' }))
    } finally {
      // A late response must be observed but must never publish a workspace.
      finishBody(phase === 'creation' ? { sandboxId: 'sbx_new' } : { restored: 1 })
      await result
    }
    expect(commit).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init.method === 'DELETE')).toHaveLength(1))
    expect(fetcher).toHaveBeenLastCalledWith('/api/sandboxes/sbx_new', expect.objectContaining({ method: 'DELETE' }))
  })

  it('does not clean up a late creation receipt with another account', async () => {
    const controller = new AbortController()
    let readingBody!: () => void
    const bodyStarted = new Promise<void>((resolve) => { readingBody = resolve })
    let finishBody!: (value: unknown) => void
    const delayedBody = new Promise<unknown>((resolve) => { finishBody = resolve })
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: () => { readingBody(); return delayedBody } })
    vi.stubGlobal('fetch', fetcher)
    const commit = vi.fn()
    const result = expect(restoreProjectSandbox({ projectId: crypto.randomUUID(), signal: controller.signal, loadFiles: async () => files, commit }))
      .rejects.toMatchObject({ name: 'AbortError' })
    await bodyStarted
    controller.abort()
    await result
    setCloudAccount(crypto.randomUUID())
    finishBody({ sandboxId: 'sbx_new' })
    await delayedBody
    await Promise.resolve()
    expect(fetcher).toHaveBeenCalledOnce()
    expect(commit).not.toHaveBeenCalled()
  })

  it('turns a stalled upload response body into a retryable deadline error', async () => {
    const deadline = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => ms === 60_000 ? deadline.signal : new AbortController().signal)
    let readingBody!: () => void
    const bodyStarted = new Promise<void>((resolve) => { readingBody = resolve })
    let finishBody!: (value: unknown) => void
    const delayedBody = new Promise<unknown>((resolve) => { finishBody = resolve })
    const fetcher = vi.fn().mockResolvedValueOnce(json({ sandboxId: 'sbx_new' }))
      .mockResolvedValueOnce({ ok: true, json: () => { readingBody(); return delayedBody } })
      .mockResolvedValueOnce(json({ stopped: true }))
    vi.stubGlobal('fetch', fetcher)
    const commit = vi.fn()
    let outcome = 'pending'
    const result = restoreProjectSandbox({ projectId: crypto.randomUUID(), signal: new AbortController().signal, loadFiles: async () => files, commit })
      .then(() => { outcome = 'resolved' }, (error: Error) => { outcome = error.message })
    await bodyStarted
    deadline.abort()
    try {
      await vi.waitFor(() => expect(outcome).toMatch(/timed out/), { timeout: 100 })
      expect(fetcher).toHaveBeenLastCalledWith('/api/sandboxes/sbx_new', expect.objectContaining({ method: 'DELETE' }))
    } finally {
      finishBody({ restored: 1 })
      await result
    }
    expect(commit).not.toHaveBeenCalled()
  })

  it('passes cancellation to the source loader before creating a replacement', async () => {
    const controller = new AbortController()
    const loadFiles = vi.fn(() => new Promise<unknown>(() => {}))
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const result = expect(restoreProjectSandbox({ projectId: crypto.randomUUID(), signal: controller.signal, loadFiles, commit: vi.fn() })).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(loadFiles).toHaveBeenCalledOnce())
    controller.abort()
    await result
    expect(loadFiles).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect((loadFiles.mock.calls as unknown as [AbortSignal][])[0][0].aborted).toBe(true)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('does not create a replacement under another account after a delayed source read', async () => {
    let finish!: (value: typeof files) => void
    const loaded = new Promise<typeof files>((resolve) => { finish = resolve })
    const fetcher = vi.fn().mockResolvedValue(json({ sandboxId: 'sbx_new', restored: 1 }))
    vi.stubGlobal('fetch', fetcher)
    const commit = vi.fn()
    const result = expect(restoreProjectSandbox({ projectId: crypto.randomUUID(), signal: new AbortController().signal, loadFiles: () => loaded, commit })).rejects.toMatchObject({ name: 'AbortError' })
    setCloudAccount(crypto.randomUUID())
    finish(files)
    await result
    expect(fetcher).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
  })

  it('does not upload, commit, or clean up using a different account after creation', async () => {
    const firstAccount = crypto.randomUUID()
    setCloudAccount(firstAccount)
    const fetcher = vi.fn(async () => { setCloudAccount(crypto.randomUUID()); return json({ sandboxId: 'sbx_new' }) })
    vi.stubGlobal('fetch', fetcher)
    const commit = vi.fn()
    await expect(restoreProjectSandbox({ projectId: crypto.randomUUID(), signal: new AbortController().signal, loadFiles: async () => files, commit })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(new Headers((fetcher.mock.calls as unknown as [string, RequestInit][])[0][1].headers).get('X-CodeTutor-Account')).toBe(firstAccount)
    expect(commit).not.toHaveBeenCalled()
  })

  it('preserves revision metadata in restoration uploads', async () => {
    const versionedFiles = [{ ...files[0], revision: 7 }]
    const fetcher = vi.fn().mockResolvedValueOnce(json({ sandboxId: 'sbx_new' })).mockResolvedValueOnce(json({ restored: 1 }))
    vi.stubGlobal('fetch', fetcher)
    await restoreProjectSandbox({ projectId: crypto.randomUUID(), signal: new AbortController().signal, loadFiles: async () => versionedFiles, commit: vi.fn() })
    expect(JSON.parse(fetcher.mock.calls[1][1].body).files).toEqual(versionedFiles)
  })

  it('times out a stuck source read before creating a replacement', async () => {
    const deadline = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const result = expect(restoreProjectSandbox({ projectId: '550e8400-e29b-41d4-a716-446655440000', signal: new AbortController().signal, loadFiles: () => new Promise(() => {}), commit: vi.fn() })).rejects.toThrow(/timed out/)
    deadline.abort()
    await result
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('does not start restoration after a cancelled source read resolves late', async () => {
    const controller = new AbortController()
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    let finish!: (value: typeof files) => void
    const loaded = new Promise<typeof files>((resolve) => { finish = resolve })
    const result = expect(restoreProjectSandbox({ projectId: '550e8400-e29b-41d4-a716-446655440000', signal: controller.signal, loadFiles: () => loaded, commit: vi.fn() })).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    finish(files)
    await result
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('restores large projects in bounded uploads, including JSON escape overhead', async () => {
    const largeFiles = Array.from({ length: 24 }, (_, index) => ({
      path: `src/file-${index}.txt`,
      // Tabs are valid source text and double in size when JSON-encoded.
      content: index % 2 ? '\t'.repeat(256 * 1024) : 'a'.repeat(256 * 1024),
    }))
    const uploaded: typeof largeFiles = []
    let uploadCount = 0
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === 'POST') return json({ sandboxId: 'sbx_new' })
      expect(init.method).toBe('PUT')
      const body = String(init.body)
      expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(MAX_RESTORE_REQUEST_BYTES)
      const batch = JSON.parse(body).files as typeof largeFiles
      uploaded.push(...batch)
      uploadCount++
      return json({ restored: batch.length })
    })
    vi.stubGlobal('fetch', fetcher)
    const commit = vi.fn(async () => { expect(uploaded).toEqual(largeFiles) })
    await restoreProjectSandbox({ projectId: '550e8400-e29b-41d4-a716-446655440000', signal: new AbortController().signal, loadFiles: async () => largeFiles, commit })
    expect(uploadCount).toBeGreaterThan(1)
    expect(commit).toHaveBeenCalledExactlyOnceWith('sbx_new')
  })

  it('cleans up the replacement without committing a partly restored project', async () => {
    const largeFiles = Array.from({ length: 12 }, (_, index) => ({ path: `${index}.txt`, content: 'a'.repeat(256 * 1024) }))
    let uploads = 0
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === 'POST') return json({ sandboxId: 'sbx_new' })
      if (init.method === 'DELETE') return json({ stopped: true })
      uploads++
      if (uploads === 2) return json({ error: { message: 'Upload failed' } }, 502)
      return json({ restored: JSON.parse(String(init.body)).files.length })
    })
    vi.stubGlobal('fetch', fetcher)
    const commit = vi.fn()
    await expect(restoreProjectSandbox({ projectId: '550e8400-e29b-41d4-a716-446655440000', signal: new AbortController().signal, loadFiles: async () => largeFiles, commit })).rejects.toThrow('Upload failed')
    expect(commit).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenLastCalledWith('/api/sandboxes/sbx_new', expect.objectContaining({ method: 'DELETE' }))
  })

  it('commits only after all files are acknowledged and does not stop the replacement', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ sandboxId: 'sbx_new' }))
      .mockResolvedValueOnce(json({ restored: 1 }))
    vi.stubGlobal('fetch', fetcher)
    const onCommitting = vi.fn()
    const commit = vi.fn(async () => {
      expect(fetcher).toHaveBeenCalledTimes(2)
      expect(onCommitting).toHaveBeenCalledOnce()
    })
    await expect(restoreProjectSandbox({ projectId: '550e8400-e29b-41d4-a716-446655440000', signal: new AbortController().signal, loadFiles: async () => files, commit, onCommitting }))
      .resolves.toEqual({ sandboxId: 'sbx_new', files })
    expect(commit).toHaveBeenCalledWith('sbx_new')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it.each([
    { stored: [] },
    { stored: [{ path: null, content: 'bad' }] },
    { stored: [...files, ...files] },
    { stored: [{ path: '../secret', content: 'bad' }] },
    { stored: [{ path: 'src', content: 'file' }, { path: 'src/app.ts', content: 'child' }] },
    { stored: [{ path: 'src/app.ts', content: 'child' }, { path: 'src', content: 'file' }] },
  ])(
    'does not create an empty or invalid replacement ($stored)', async ({ stored }) => {
      const fetcher = vi.fn()
      vi.stubGlobal('fetch', fetcher)
      await expect(restoreProjectSandbox({ projectId: '550e8400-e29b-41d4-a716-446655440000', signal: new AbortController().signal, loadFiles: async () => stored, commit: vi.fn() }))
        .rejects.toThrow(/snapshot/)
      expect(fetcher).not.toHaveBeenCalled()
    }
  )

  it.each([json({ restored: 0 }), new Response(''), json({ error: { message: 'Restore failed.' } }, 502)])(
    'cleans up a replacement when restore confirmation fails', async (response) => {
      const fetcher = vi.fn().mockResolvedValueOnce(json({ sandboxId: 'sbx_new' }))
        .mockResolvedValueOnce(response).mockResolvedValueOnce(json({ stopped: true }))
      vi.stubGlobal('fetch', fetcher)
      const commit = vi.fn()
      await expect(restoreProjectSandbox({ projectId: '550e8400-e29b-41d4-a716-446655440000', signal: new AbortController().signal, loadFiles: async () => files, commit })).rejects.toThrow()
      expect(commit).not.toHaveBeenCalled()
      expect(fetcher).toHaveBeenLastCalledWith('/api/sandboxes/sbx_new', expect.objectContaining({ method: 'DELETE' }))
    }
  )

  it('does not attach a replacement when project navigation cancels restoration', async () => {
    const controller = new AbortController()
    const fetcher = vi.fn().mockResolvedValueOnce(json({ sandboxId: 'sbx_new' }))
      .mockImplementationOnce(async () => { controller.abort(); return json({ restored: 1 }) })
      .mockResolvedValueOnce(json({ stopped: true }))
    vi.stubGlobal('fetch', fetcher)
    const commit = vi.fn()
    const onCommitting = vi.fn()
    await expect(restoreProjectSandbox({ projectId: '550e8400-e29b-41d4-a716-446655440000', signal: controller.signal, loadFiles: async () => files, commit, onCommitting })).rejects.toThrow()
    expect(commit).not.toHaveBeenCalled()
    expect(onCommitting).not.toHaveBeenCalled()
    expect((fetcher.mock.calls[2][1] as RequestInit).signal?.aborted).toBe(false)
  })

  it('keeps acknowledged restored files if reopening the project cannot be confirmed', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ sandboxId: 'sbx_new' }))
      .mockResolvedValueOnce(json({ restored: 1 })).mockResolvedValueOnce(json({ stopped: true }))
    vi.stubGlobal('fetch', fetcher)
    await expect(restoreProjectSandbox({ projectId: '550e8400-e29b-41d4-a716-446655440000', signal: new AbortController().signal, loadFiles: async () => files, commit: async () => { throw new Error('Storage full') } }))
      .rejects.toMatchObject({ name: 'SandboxReopenRequiredError' })
    // The server registers the VM before this final request. Its failure is
    // not evidence that the replacement is unowned or that a write rolled back.
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('keeps an already committed replacement if navigation happens during persistence', async () => {
    const controller = new AbortController()
    const fetcher = vi.fn().mockResolvedValueOnce(json({ sandboxId: 'sbx_new' }))
      .mockResolvedValueOnce(json({ restored: 1 }))
    vi.stubGlobal('fetch', fetcher)
    await restoreProjectSandbox({ projectId: '550e8400-e29b-41d4-a716-446655440000', signal: controller.signal, loadFiles: async () => files, commit: async () => { controller.abort() } })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('turns a stalled restore into a retryable timeout and cleans up', async () => {
    const deadline = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => ms === 60_000 ? deadline.signal : new AbortController().signal)
    const fetcher = vi.fn().mockResolvedValueOnce(json({ sandboxId: 'sbx_new' }))
      .mockImplementationOnce(async () => { deadline.abort(); throw deadline.signal.reason })
      .mockResolvedValueOnce(json({ stopped: true }))
    vi.stubGlobal('fetch', fetcher)
    await expect(restoreProjectSandbox({ projectId: '550e8400-e29b-41d4-a716-446655440000', signal: new AbortController().signal, loadFiles: async () => files, commit: vi.fn() })).rejects.toThrow(/timed out/)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
})
