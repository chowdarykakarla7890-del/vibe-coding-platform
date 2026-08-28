import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { acknowledgeArchiveImport, cancelPendingArchiveImport, checkPendingArchiveImport, downloadImportedArchive, importProjectArchive, readImportedArchivePage } from '@/lib/learning/archive-import'
import { setCloudAccount } from '@/lib/learning/cloud-request'
import { inspectArchive } from '@/lib/projects/archive-import'
import { archiveFixture, archiveBlob, combinedArchive, date, projectRecord, sourceRecord } from './fixtures/project-archive'

const owner = '44444444-4444-4444-8444-444444444444'
let fixture: Awaited<ReturnType<typeof archiveFixture>>
let fetcher: ReturnType<typeof vi.fn>, id: string, uploaded: number, published: boolean
function receipt(state = published ? 'published' : 'uploading') {
  return { id, state, expiresAt: date, manifest: fixture.manifest, digest: fixture.digest, uploadedRecords: uploaded,
    uploadedBytes: fixture.envelopes.slice(0, uploaded).reduce((sum, e) => sum + new TextEncoder().encode(e.record).length, 0),
    project: state === 'published' ? { id, title: 'Recovered', language: 'TypeScript', mode: 'playground', status: 'active', activity_id: null, created_at: date, updated_at: date } : null }
}
beforeEach(async () => {
  fixture = await archiveFixture(); uploaded = 0; published = false
  const storage = new Map<string, string>()
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } })
  setCloudAccount(owner)
  fetcher = vi.fn(async (_path: string, options: RequestInit) => {
    const body = options.body ? JSON.parse(String(options.body)) : undefined
    if (body?.id) { id = body.id; return Response.json(receipt()) }
    if (body?.records) { uploaded = body.records.at(-1).index; return Response.json(receipt()) }
    if (options.method === 'DELETE') { if (!published) uploaded = 0; return Response.json(receipt(published ? 'published' : 'cancelled')) }
    if (options.method === 'POST') published = true
    return Response.json(receipt())
  })
  vi.stubGlobal('fetch', fetcher)
})
afterEach(() => { setCloudAccount(undefined); vi.unstubAllGlobals(); vi.restoreAllMocks() })
it('validates and stages every record, atomically publishes and leaves authority with the server', async () => {
  const project = await importProjectArchive(fixture.blob, new AbortController().signal)
  expect(project).toMatchObject({ id, mode: 'playground', status: 'active' })
  expect(project.sandboxId).toBeUndefined()
  expect(fetcher).toHaveBeenCalledTimes(3)
  expect(JSON.parse(String(fetcher.mock.calls[1][1].body)).records).toEqual(fixture.envelopes)
  expect(await checkPendingArchiveImport(new AbortController().signal)).toMatchObject({ state: 'published', project: { id } })
  acknowledgeArchiveImport(id)
  expect(await checkPendingArchiveImport(new AbortController().signal)).toBeUndefined()
})
it('never starts an upload for an incomplete archive or trailing records', async () => {
  await expect(importProjectArchive(archiveBlob(fixture.lines.slice(0, -1)), new AbortController().signal)).rejects.toThrow()
  await expect(importProjectArchive(archiveBlob([...fixture.lines, fixture.end]), new AbortController().signal)).rejects.toThrow()
  expect(fetcher).not.toHaveBeenCalled()
})
it('recovers a lost commit response using the same ID without re-uploading or deleting work', async () => {
  fetcher.mockImplementationOnce(async (_path, options) => { id = JSON.parse(String(options.body)).id; return Response.json(receipt()) })
    .mockImplementationOnce(async () => { uploaded = fixture.envelopes.length; return Response.json(receipt()) })
    .mockImplementationOnce(async () => { published = true; throw new TypeError('network unavailable') })
  await expect(importProjectArchive(fixture.blob, new AbortController().signal)).rejects.toThrow()
  const previousId = id
  expect((await importProjectArchive(fixture.blob, new AbortController().signal)).id).toBe(previousId)
  expect(fetcher).toHaveBeenCalledTimes(4)
  expect(fetcher.mock.calls.some(call => call[1].method === 'DELETE')).toBe(false)
})
it('resumes a partial upload at its verified ordinal without re-sending completed batches', async () => {
  fixture = await archiveFixture([projectRecord, sourceRecord, ...Array.from({ length: 43 }, (_, index) => ({ kind: 'message', key: String(index), data: { text: 'saved history' } }))])
  fetcher.mockImplementationOnce(async (_path, options) => { id = JSON.parse(String(options.body)).id; return Response.json(receipt()) })
    .mockImplementationOnce(async () => { uploaded = 20; return Response.json(receipt()) })
    .mockRejectedValueOnce(new TypeError('upload interrupted'))
  await expect(importProjectArchive(fixture.blob, new AbortController().signal)).rejects.toThrow()
  const previousId = id
  fetcher.mockClear()
  expect((await importProjectArchive(fixture.blob, new AbortController().signal)).id).toBe(previousId)
  const batches = fetcher.mock.calls.filter(call => call[1].method === 'PUT').map(call => JSON.parse(String(call[1].body)).records)
  expect(batches.map(batch => batch.length)).toEqual([20, 5])
  expect(batches[0][0].index).toBe(21)
})
it('waits through a bounded quota pause and retries the identical upload', async () => {
  const progress = vi.fn()
  fetcher.mockImplementationOnce(async (_path, options) => { id = JSON.parse(String(options.body)).id; return Response.json(receipt()) })
    .mockResolvedValueOnce(Response.json({ error: { code: 'RATE_LIMITED', message: 'Wait' } }, { status: 429, headers: { 'Retry-After': '1' } }))
  await importProjectArchive(fixture.blob, new AbortController().signal, progress)
  expect(progress.mock.calls.some(([value]) => value.phase === 'uploading' && value.waitingSeconds === 1)).toBe(true)
  const uploads = fetcher.mock.calls.filter(call => call[1].method === 'PUT')
  expect(uploads).toHaveLength(2); expect(uploads[0][1].body).toBe(uploads[1][1].body)
})
it('cancellation returns the published project intact and clears only cancelled staging', async () => {
  await importProjectArchive(fixture.blob, new AbortController().signal)
  expect(await cancelPendingArchiveImport(new AbortController().signal)).toMatchObject({ state: 'published', project: { id } })
  expect(window.localStorage.getItem(`codetutor-archive-import:${owner}`)).toBeTruthy()
  published = false
  expect(await cancelPendingArchiveImport(new AbortController().signal)).toMatchObject({ state: 'cancelled' })
  expect(window.localStorage.getItem(`codetutor-archive-import:${owner}`)).toBeNull()
})
it('a different archive cannot reuse a pending upload', async () => {
  await importProjectArchive(fixture.blob, new AbortController().signal)
  fetcher.mockClear()
  const changed = archiveBlob([{ ...fixture.manifest, id: '55555555-5555-4555-8555-555555555555' }, ...fixture.envelopes, { ...fixture.end, id: '55555555-5555-4555-8555-555555555555' }])
  await expect(importProjectArchive(changed, new AbortController().signal)).rejects.toThrow(/Another archive/)
  expect(fetcher).not.toHaveBeenCalled()
})
it('a stopped response body preserves its resume ID and never publishes', async () => {
  fetcher.mockImplementationOnce(async (_path, options) => { id = JSON.parse(String(options.body)).id; return { ok: true, json: () => new Promise(() => {}) } })
  const controller = new AbortController()
  const work = expect(importProjectArchive(fixture.blob, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
  controller.abort(); await work
  expect(window.localStorage.getItem(`codetutor-archive-import:${owner}`)).toContain(id)
  expect(published).toBe(false)
})
it('changing accounts cancels all pending reads before they can use another session', async () => {
  fetcher.mockImplementationOnce(async (_path, options) => { id = JSON.parse(String(options.body)).id; return { ok: true, json: () => new Promise(() => {}) } })
  const work = expect(importProjectArchive(fixture.blob, new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
  setCloudAccount('55555555-5555-4555-8555-555555555555'); await work
  expect(await checkPendingArchiveImport(new AbortController().signal)).toBeUndefined()
  expect(new Headers(fetcher.mock.calls[0][1].headers).get('X-CodeTutor-Account')).toBe(owner)
})
it.each([2, 3])('downloads every version-%s original record and manifest without replaying history or deleting evidence', async version => {
  if (version === 3) fixture = await combinedArchive(await combinedArchive(fixture))
  id = crypto.randomUUID()
  fetcher.mockImplementation(async (path: string) => {
    const after = Number(new URL(path, 'http://localhost').searchParams.get('after'))
    const records = fixture.envelopes.slice(after, after + 3), next = after + records.length
    return Response.json({ id, manifest: fixture.manifest, digest: fixture.digest, provenance: 'imported-unverified', records, nextCursor: next < fixture.envelopes.length ? next : null })
  })
  const downloaded = await downloadImportedArchive(id, new AbortController().signal)
  expect(await inspectArchive(downloaded, new AbortController().signal)).toMatchObject({ manifest: fixture.manifest, digest: fixture.digest })
  const lines = (await downloaded.text()).trim().split('\n').map(line => JSON.parse(line))
  expect(lines.slice(1, -1)).toEqual(fixture.envelopes)
  expect(fetcher.mock.calls.every(call => call[1].method === 'GET')).toBe(true)
})

it('uploads flat history metadata unchanged and uses its version-aware digest', async () => {
  fixture = await combinedArchive(await combinedArchive(fixture))
  await importProjectArchive(fixture.blob, new AbortController().signal)
  const header = JSON.parse(String(fetcher.mock.calls[0][1].body))
  expect(header.manifest.version).toBe(3)
  expect(header.digest).toBe(fixture.digest)
  const uploaded = fetcher.mock.calls.filter(call => call[1].method === 'PUT').flatMap(call => JSON.parse(String(call[1].body)).records)
  expect(uploaded).toEqual(fixture.envelopes)
})
it('rejects history pages for another project and corrupt downloaded evidence', async () => {
  id = crypto.randomUUID()
  fetcher.mockResolvedValue(Response.json({ id: crypto.randomUUID(), manifest: fixture.manifest, digest: fixture.digest, provenance: 'imported-unverified', records: fixture.envelopes, nextCursor: null }))
  await expect(readImportedArchivePage(id, 0, new AbortController().signal)).rejects.toThrow(/another project/)
  fetcher.mockResolvedValue(Response.json({ id, manifest: fixture.manifest, digest: '0'.repeat(64), provenance: 'imported-unverified', records: fixture.envelopes, nextCursor: null }))
  await expect(downloadImportedArchive(id, new AbortController().signal)).rejects.toThrow(/incomplete/)
})
