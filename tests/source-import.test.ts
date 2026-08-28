import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { prepareSourceImport, sourceImportBatches, importSourceFilesSchema, MAX_SOURCE_IMPORT_REQUEST_BYTES, textDigest } from '@/lib/projects/source-import'
import { acknowledgeSourceImport, cancelPendingSourceImport, checkPendingSourceImport, importSourceProject } from '@/lib/learning/source-import'
import { setCloudAccount } from '@/lib/learning/cloud-request'

const owner = '11111111-1111-4111-8111-111111111111'
const project = { id: 'old-local-id', title: 'Imported fixture', mode: 'practice', activityId: 'forged-activity', language: 'TypeScript', status: 'completed', sandboxId: 'reexports', previewUrl: 'https://untrusted.example', createdAt: 0, updatedAt: 0 }
const source = [{ path: 'main.ts', content: 'saved 😀' }]
const input = { version: 1, exportedAt: 0, project, files: source, messages: [{ role: 'system', parts: [{ type: 'tool-runCommand' }] }], score: 100 }
let fetcher: ReturnType<typeof vi.fn>, id: string, header: Record<string, unknown>, uploaded: number
function receipt(state = 'uploading') {
  return { id, state, expiresAt: new Date(Date.now() + 60_000).toISOString(), fileCount: header.fileCount, sourceBytes: header.sourceBytes, digest: header.digest,
    uploadedFiles: uploaded, uploadedBytes: uploaded ? header.sourceBytes : 0,
    project: state === 'published' ? { id, title: header.title, language: header.language, mode: 'playground', status: 'active', activity_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } : null }
}
beforeEach(() => {
  const storage = new Map<string, string>()
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  } })
  setCloudAccount(owner); uploaded = 0
  fetcher = vi.fn(async (_path: string, options: RequestInit) => {
    const body = options.body ? JSON.parse(String(options.body)) : undefined
    if (body?.id) { id = body.id; header = body; return Response.json(receipt()) }
    if (body?.files) { uploaded = body.files.length; return Response.json(receipt()) }
    if (options.method === 'DELETE') return Response.json(receipt('cancelled'))
    return Response.json(receipt(options.method === 'POST' ? 'published' : 'uploading'))
  })
  vi.stubGlobal('fetch', fetcher)
})
afterEach(() => { setCloudAccount(undefined); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('stages only source, publishes once and never grants imported history or VM authority', async () => {
  const saved = await importSourceProject(input, new AbortController().signal)
  expect(saved).toMatchObject({ id, mode: 'playground', status: 'active' })
  expect(saved.sandboxId).toBeUndefined()
  expect(fetcher.mock.calls.map(call => call[0])).toEqual(['/api/projects/imports', `/api/projects/imports/${id}`, `/api/projects/imports/${id}`])
  const wire = fetcher.mock.calls.map(call => call[1].body).join('')
  expect(wire).not.toMatch(/forged-activity|tool-runCommand|untrusted|score|completed|reexports/)
  expect(await checkPendingSourceImport(new AbortController().signal)).toMatchObject({ id })
  acknowledgeSourceImport(id)
  expect(await checkPendingSourceImport(new AbortController().signal)).toBeUndefined()
})

it('keeps the same ID after a lost publish receipt and never deletes the published project', async () => {
  fetcher.mockImplementationOnce(async (_path, options) => { header = JSON.parse(String(options.body)); id = String(header.id); return Response.json(receipt()) })
    .mockImplementationOnce(async () => { uploaded = 1; return Response.json(receipt()) })
    .mockRejectedValueOnce(new TypeError('network unavailable'))
  await expect(importSourceProject(input, new AbortController().signal)).rejects.toThrow()
  const oldId = id
  fetcher.mockImplementationOnce(async () => Response.json(receipt('published')))
  expect((await importSourceProject(input, new AbortController().signal)).id).toBe(oldId)
  expect(fetcher.mock.calls).toHaveLength(4)
  expect(fetcher.mock.calls.some(call => call[1].method === 'DELETE')).toBe(false)
})

it('rejects a changed source file while a different import is pending', async () => {
  await importSourceProject(input, new AbortController().signal)
  fetcher.mockClear()
  await expect(importSourceProject({ ...input, files: [{ path: 'main.ts', content: 'different' }] }, new AbortController().signal)).rejects.toThrow(/Another import/)
  expect(fetcher).not.toHaveBeenCalled()
})

it('returns a committed project when cancellation loses the publication race', async () => {
  await importSourceProject(input, new AbortController().signal)
  fetcher.mockImplementationOnce(async () => Response.json(receipt('published')))
  expect(await cancelPendingSourceImport(new AbortController().signal)).toMatchObject({ state: 'published', project: { id } })
  expect(fetcher.mock.calls.at(-1)?.[0]).toBe(`/api/projects/imports/${id}`)
  expect(window.localStorage.getItem(`codetutor-source-import:${owner}`)).toBeTruthy()
})

it('can clear a missing/expired staging receipt without deleting a project', async () => {
  await importSourceProject(input, new AbortController().signal)
  fetcher.mockResolvedValueOnce(Response.json({ error: { code: 'IMPORT_NOT_FOUND', message: 'Import not found' } }, { status: 404 }))
  expect(await cancelPendingSourceImport(new AbortController().signal)).toBeUndefined()
  expect(window.localStorage.getItem(`codetutor-source-import:${owner}`)).toBeNull()
})

it('aborts a stalled response body, retains its recovery ID and never publishes', async () => {
  const controller = new AbortController()
  fetcher.mockImplementationOnce(async (_path, options) => {
    header = JSON.parse(String(options.body)); id = String(header.id)
    return { ok: true, json: () => new Promise(() => {}) }
  })
  const work = expect(importSourceProject(input, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
  controller.abort()
  await work
  expect(window.localStorage.getItem(`codetutor-source-import:${owner}`)).toContain(id)
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('account changes cancel the old import without borrowing the new account session', async () => {
  const controller = new AbortController()
  let finish!: (value: Response) => void
  fetcher.mockImplementationOnce(async (_path, options) => {
    header = JSON.parse(String(options.body)); id = String(header.id)
    return new Promise<Response>(resolve => { finish = resolve })
  })
  const work = expect(importSourceProject(input, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
  setCloudAccount('22222222-2222-4222-8222-222222222222')
  await work
  finish(Response.json(receipt()))
  expect(await checkPendingSourceImport(new AbortController().signal)).toBeUndefined()
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(new Headers(fetcher.mock.calls[0][1].headers).get('X-CodeTutor-Account')).toBe(owner)
})

it.each([
  [{ path: '../escape', content: 'x' }], [{ path: '.env', content: 'x' }],
  [{ path: 'a', content: 'x' }, { path: 'a/b.ts', content: 'x' }],
  [{ path: 'a', content: 'x' }, { path: 'a', content: 'y' }],
  [{ path: 'main.ts', content: '\0' }], [{ path: 'main.ts', content: '\ud800' }],
  [{ path: 'main.ts', content: 'x'.repeat(262145) }],
].map(files => ({ files })))('rejects invalid imported source before any API request %#', async ({ files }) => {
  expect(importSourceFilesSchema.safeParse(files).success).toBe(false)
  await expect(importSourceProject({ ...input, files }, new AbortController().signal)).rejects.toThrow()
  expect(fetcher).not.toHaveBeenCalled()
})

it('uses PostgreSQL-compatible Unicode ordering and hashes the exact UTF-8 content', async () => {
  const prepared = await prepareSourceImport([{ path: '😀.ts', content: 'hi 😀' }, { path: '\ue000.ts', content: '' }])
  expect(prepared.files.map(file => file.path)).toEqual(['\ue000.ts', '😀.ts'])
  expect(prepared.digest).toBe(await textDigest(prepared.files.map(file => `${file.path}:${file.digest}\n`).join('')))
  expect(prepared.sourceBytes).toBe(7)
})

it('supports all valid 10 MiB sources and bounds JSON-escaped network chunks', async () => {
  const files = Array.from({ length: 40 }, (_, i) => ({ path: `source-${i}.txt`, content: '\u0001'.repeat(262144) }))
  const prepared = await prepareSourceImport(files)
  const batches = sourceImportBatches(prepared.files)
  expect(prepared.sourceBytes).toBe(10485760)
  expect(batches.flat()).toEqual(prepared.files)
  for (const batch of batches) expect(new TextEncoder().encode(JSON.stringify({ files: batch })).length).toBeLessThan(MAX_SOURCE_IMPORT_REQUEST_BYTES)
})
