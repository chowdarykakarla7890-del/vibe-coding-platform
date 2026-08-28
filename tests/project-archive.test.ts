import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { archivePageSchema, archiveReceiptSchema, verifyArchivePage } from '@/lib/projects/archive'
import { downloadProjectArchive } from '@/lib/learning/project-archive'
import { setCloudAccount } from '@/lib/learning/cloud-request'
import { archiveFixture, combinedArchive, repackArchive } from './fixtures/project-archive'
import { inspectArchive } from '@/lib/projects/archive-import'

const projectId = '11111111-1111-4111-8111-111111111111', id = '22222222-2222-4222-8222-222222222222'
const accountA = '33333333-3333-4333-8333-333333333333', accountB = '44444444-4444-4444-8444-444444444444'
const record = JSON.stringify({ kind: 'project', key: projectId, data: { id: projectId, title: 'Synthetic 😀' } })
const envelope = { index: 1, record, sha256: createHash('sha256').update(record).digest('hex') }
const receipt = { id, projectId, createdAt: '2026-08-27T00:00:00Z', expiresAt: '2026-08-27T00:30:00Z', recordCount: 1, payloadBytes: Buffer.byteLength(record) }
const page = { id, records: [envelope], nextCursor: null }
beforeEach(() => setCloudAccount(accountA))
afterEach(() => { setCloudAccount(undefined); vi.unstubAllGlobals(); vi.useRealTimers() })

it('verifies UTF-8 bytes and record hashes rather than string length', async () => {
  expect(await verifyArchivePage(receipt, page, 0)).toBe(Buffer.byteLength(record))
})
it.each([
  { ...page, id: projectId }, { ...page, records: [] }, { ...page, nextCursor: 1 },
  { ...page, records: [{ ...envelope, index: 2 }] }, { ...page, records: [{ ...envelope, record: record + ' ' }] },
  { ...page, records: [envelope, envelope] },
])('rejects missing, duplicate, corrupted or cross-export records', async (input) => {
  await expect(verifyArchivePage(receipt, input, 0)).rejects.toThrow()
})
it('rejects a valid hash that identifies a different project', async () => {
  const text = record.replace(projectId, id).replace(projectId, id)
  await expect(verifyArchivePage(receipt, { ...page, records: [{ ...envelope, record: text, sha256: createHash('sha256').update(text).digest('hex') }] }, 0)).rejects.toThrow('invalid')
})
it('rejects oversized archive manifests and unbounded pages', () => {
  expect(archiveReceiptSchema.safeParse({ ...receipt, recordCount: 50001 }).success).toBe(false)
  expect(archiveReceiptSchema.safeParse({ ...receipt, payloadBytes: 256 * 1024 * 1024 + 1 }).success).toBe(false)
  expect(archivePageSchema.safeParse({ ...page, records: Array(21).fill(envelope) }).success).toBe(false)
})
function responses(mutatePage: (value: typeof page) => unknown = value => value) {
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => new Response(JSON.stringify(init?.method === 'POST' ? receipt : init?.method === 'DELETE' ? { deleted: true } : mutatePage(page)), { status: 200 }))
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
it('downloads only a complete verified archive and cleans only its staging copy', async () => {
  const fetcher = responses(), progress = vi.fn()
  const blob = await downloadProjectArchive(projectId, new AbortController().signal, progress)
  const lines = (await blob.text()).trim().split('\n').map(line => JSON.parse(line))
  expect(lines[0]).toMatchObject({ version: 2, format: 'codetutor-project-archive', includesUnsavedDrafts: false })
  expect(lines[1]).toEqual(envelope)
  expect(lines[2]).toEqual({ complete: true, id, recordCount: 1, payloadBytes: receipt.payloadBytes })
  expect(progress).toHaveBeenLastCalledWith(1, 1)
  expect(fetcher.mock.calls.at(-1)?.[0]).toBe(`/api/projects/${projectId}/archives/${id}`)
  expect(fetcher.mock.calls.at(-1)?.[1]?.method).toBe('DELETE')
})
it('never returns a partial download on hash failure but still cleans temporary records', async () => {
  const fetcher = responses(value => ({ ...value, records: [{ ...envelope, sha256: 'a'.repeat(64) }] }))
  await expect(downloadProjectArchive(projectId, new AbortController().signal, vi.fn())).rejects.toThrow('integrity')
  expect(fetcher.mock.calls.at(-1)?.[1]?.method).toBe('DELETE')
})
it('rejects final byte-count mismatches', async () => {
  const fetcher = responses()
  fetcher.mockImplementationOnce(async () => new Response(JSON.stringify({ ...receipt, payloadBytes: receipt.payloadBytes + 1 })))
  await expect(downloadProjectArchive(projectId, new AbortController().signal, vi.fn())).rejects.toThrow('incomplete')
})
it('aborts a stalled page and uses a fresh signal for same-account staging cleanup', async () => {
  const controller = new AbortController(), entered = Promise.withResolvers<void>()
  let pageSignal: AbortSignal | undefined, cleanupSignal: AbortSignal | undefined
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    if (init.method === 'POST') return new Response(JSON.stringify(receipt))
    if (init.method === 'DELETE') { cleanupSignal = init.signal; return new Response(JSON.stringify({ deleted: true })) }
    pageSignal = init.signal; entered.resolve(); return new Promise(() => {})
  }))
  const task = downloadProjectArchive(projectId, controller.signal, vi.fn())
  await entered.promise; controller.abort()
  await expect(task).rejects.toThrow()
  expect(pageSignal?.aborted).toBe(true)
  expect(cleanupSignal?.aborted).toBe(false)
})
it('does not perform cleanup under a replacement account', async () => {
  const fetcher = responses()
  fetcher.mockImplementationOnce(async () => { setCloudAccount(accountB); return new Response(JSON.stringify(receipt)) })
  await expect(downloadProjectArchive(projectId, new AbortController().signal, vi.fn())).rejects.toThrow()
  expect(fetcher).toHaveBeenCalledOnce()
})
it('honors a bounded read quota pause without restarting the archive', async () => {
  vi.useFakeTimers()
  const entered = Promise.withResolvers<void>(), fetcher = responses(), progress = vi.fn()
  fetcher.mockImplementationOnce(async () => new Response(JSON.stringify(receipt)))
  fetcher.mockImplementationOnce(async () => { entered.resolve(); return new Response('{}', { status: 429, headers: { 'Retry-After': '1' } }) })
  const task = downloadProjectArchive(projectId, new AbortController().signal, progress)
  await entered.promise
  await vi.advanceTimersByTimeAsync(1000)
  await task
  expect(progress).toHaveBeenCalledWith(0, 1, 1)
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
})

it.each([false, true])('fully validates combined sections before downloading (corrupt: %s)', async corrupt => {
  let fixture = await combinedArchive(await combinedArchive(await archiveFixture()))
  if (corrupt) fixture = await repackArchive(fixture.manifest, fixture.envelopes.slice(0, -1))
  const { id, projectId, createdAt, expiresAt, recordCount, payloadBytes, version } = fixture.manifest
  const metadata = { id, projectId, createdAt, expiresAt, recordCount, payloadBytes }
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return Response.json({ ...metadata, formatVersion: version })
    if (init?.method === 'DELETE') return Response.json({ deleted: true })
    const after = Number(new URL(url, 'http://localhost').searchParams.get('after'))
    const records = fixture.envelopes.slice(after, after + 5), next = after + records.length
    return Response.json({ id: metadata.id, records, nextCursor: next < metadata.recordCount ? next : null })
  })
  vi.stubGlobal('fetch', fetcher)
  const download = downloadProjectArchive(metadata.projectId, new AbortController().signal, vi.fn())
  if (corrupt) await expect(download).rejects.toThrow(/section/)
  else {
    const blob = await download
    expect(await inspectArchive(blob, new AbortController().signal)).toMatchObject({ manifest: fixture.manifest, digest: fixture.digest })
  }
  expect(fetcher.mock.calls.at(-1)?.[1]?.method).toBe('DELETE')
})
