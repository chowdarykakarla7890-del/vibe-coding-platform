'use client'

import { z } from 'zod'
import { cloudOperation } from './cloud-request'
import { readLocalPreference, writeLocalPreference } from '@/lib/local-preferences'
import { readWithDeadline } from '@/lib/abortable-read'
import { abortableDelay } from '@/lib/abortable-delay'
import { getApiErrorMessage } from '@/lib/api-error'
import { archiveBatchFits, archiveImportReceiptSchema, importedArchivePageSchema, inspectArchive, readArchive, type ArchiveImportReceipt, type ImportedArchivePage } from '@/lib/projects/archive-import'
import { archiveDigestLine, verifyArchivePage, type ArchiveEnvelope } from '@/lib/projects/archive'
import { textDigest } from '@/lib/projects/source-import'

const pendingSchema = z.object({ id: z.string().uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
class ArchiveRequestError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfter: number) { super(message) }
}
function key(userId: string) { return `codetutor-archive-import:${userId}` }
function pending(userId: string) {
  try { return pendingSchema.parse(JSON.parse(readLocalPreference(key(userId)) ?? 'null')) } catch { return undefined }
}

async function request(operation: ReturnType<typeof cloudOperation>, path: string, method: string, body?: unknown) {
  return readWithDeadline(async signal => {
    const response = await operation.fetch(path, { method, signal, cache: 'no-store',
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
    const value: unknown = await response.json().catch(() => undefined)
    operation.assertActive()
    if (!response.ok) throw new ArchiveRequestError(getApiErrorMessage(value, 'Archive recovery could not be confirmed. Retry with the original file.'), response.status, Math.max(1, Math.min(60, Number(response.headers.get('Retry-After')) || 1)))
    return value
  }, operation.signal, 20_000, 'Archive request timed out. Resume with the same file; existing projects are unchanged.')
}
async function receiptRequest(operation: ReturnType<typeof cloudOperation>, id: string | undefined, method: string, body?: unknown) {
  const receipt = archiveImportReceiptSchema.parse(await request(operation, `/api/projects/archive-imports${id ? `/${id}` : ''}`, method, body))
  if (id && receipt.id !== id) throw new Error('Archive receipt belongs to a different import.')
  return receipt
}

export async function checkPendingArchiveImport(signal: AbortSignal) {
  const operation = cloudOperation(signal), saved = pending(operation.userId)
  if (!saved) return undefined
  return receiptRequest(operation, saved.id, 'GET')
}
export async function cancelPendingArchiveImport(signal: AbortSignal) {
  const operation = cloudOperation(signal), saved = pending(operation.userId)
  if (!saved) return undefined
  let receipt: ArchiveImportReceipt
  try { receipt = await receiptRequest(operation, saved.id, 'DELETE') }
  catch (error) {
    if (error instanceof ArchiveRequestError && (error.status === 404 || error.status === 410)) {
      operation.assertActive(); writeLocalPreference(key(operation.userId), null); return undefined
    }
    throw error
  }
  operation.assertActive()
  if (receipt.state === 'cancelled') writeLocalPreference(key(operation.userId), null)
  return receipt
}
export function acknowledgeArchiveImport(id: string) {
  const operation = cloudOperation()
  if (pending(operation.userId)?.id === id) writeLocalPreference(key(operation.userId), null)
}
export type ArchiveImportProgress =
  | { phase: 'validating'; records: number }
  | { phase: 'uploading'; receipt: ArchiveImportReceipt; waitingSeconds?: number }

/** Validate the entire immutable File before staging anything, then stream it
 * again in bounded batches. Pause never deletes a possibly committed project.
 */
export async function importProjectArchive(file: Blob, signal: AbortSignal, onProgress: (progress: ArchiveImportProgress) => void = () => {}) {
  const owner = cloudOperation(signal)
  return readWithDeadline(async deadline => {
    const operation = cloudOperation(deadline)
    onProgress({ phase: 'validating', records: 0 })
    let notifiedAt = 0
    const checked = await inspectArchive(file, deadline, records => {
      operation.assertActive()
      if (records === 1 || performance.now() - notifiedAt >= 100) {
        notifiedAt = performance.now(); onProgress({ phase: 'validating', records })
      }
    })
    operation.assertActive()
    const fingerprint = await textDigest(JSON.stringify(checked.manifest) + checked.digest)
    const saved = pending(owner.userId)
    if (saved && saved.fingerprint !== fingerprint) throw new Error('Another archive import is pending. Resume with the original file or cancel it first.')
    const id = saved?.id ?? crypto.randomUUID()
    if (!writeLocalPreference(key(owner.userId), JSON.stringify({ id, digest: checked.digest, fingerprint }))) throw new Error('Allow browser storage before importing so an interrupted upload can be recovered.')
    let receipt = await receiptRequest(operation, undefined, 'POST', { id, manifest: checked.manifest, digest: checked.digest })
    const check = (value: ArchiveImportReceipt) => {
      if (value.id !== id || value.digest !== checked.digest || JSON.stringify(value.manifest) !== JSON.stringify(checked.manifest)) throw new Error('Archive receipt did not match the selected file.')
      if (value.state === 'cancelled') throw new Error('This import was cancelled. Choose the archive again to begin a new import.')
      onProgress({ phase: 'uploading', receipt: value })
    }
    check(receipt)
    if (receipt.state !== 'published') {
      let batch: ArchiveEnvelope[] = [], throttles = 0
      const upload = async () => {
        if (!batch.length) return
        while (true) {
          try { receipt = await receiptRequest(operation, id, 'PUT', { records: batch }); check(receipt); batch = []; break }
          catch (error) {
            if (!(error instanceof ArchiveRequestError) || error.status !== 429 || throttles++ >= 60) throw error
            onProgress({ phase: 'uploading', receipt, waitingSeconds: error.retryAfter })
            await abortableDelay(error.retryAfter * 1000, deadline)
          }
        }
      }
      for await (const item of readArchive(file, deadline)) {
        if (item.type !== 'record' || item.envelope.index <= receipt.uploadedRecords) continue
        if (!archiveBatchFits([...batch, item.envelope])) await upload()
        batch.push(item.envelope)
      }
      await upload()
      receipt = await receiptRequest(operation, id, 'POST', {})
      check(receipt)
    }
    operation.assertActive()
    if (receipt.state !== 'published' || !receipt.project) throw new Error('The archive has not been fully published. Resume with the same file.')
    return receipt.project
  }, owner.signal, 45 * 60_000, 'Archive import paused. Resume with the original file; existing work is unchanged.')
}

export async function readImportedArchivePage(projectId: string, after: number, signal: AbortSignal) {
  z.string().uuid().parse(projectId)
  const operation = cloudOperation(signal)
  const page = importedArchivePageSchema.parse(await request(operation, `/api/projects/${projectId}/imported-archive?after=${after}`, 'GET'))
  if (page.id !== projectId) throw new Error('Imported history belongs to another project.')
  await verifyArchivePage(page.manifest, { id: page.manifest.id, records: page.records, nextCursor: page.nextCursor }, after)
  operation.assertActive()
  return page
}

/** Download the original evidence exactly, including its original manifest.
 * Full project archive combines this evidence with current saved work; this
 * optional download returns only the unchanged file originally imported.
 */
export async function downloadImportedArchive(projectId: string, signal: AbortSignal, onProgress: (count: number, total: number) => void = () => {}) {
  const owner = cloudOperation(signal)
  return readWithDeadline(async deadline => {
    const parts: BlobPart[] = [], digests: string[] = []
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) + '\n')
    let first: ImportedArchivePage | undefined, after = 0, bytes = 0, throttles = 0
    do {
      let page: ImportedArchivePage
      try { page = await readImportedArchivePage(projectId, after, deadline) }
      catch (error) {
        if (!(error instanceof ArchiveRequestError) || error.status !== 429 || throttles++ >= 20) throw error
        await abortableDelay(error.retryAfter * 1000, deadline); continue
      }
      owner.assertActive()
      if (!first) { first = page; parts.push(encode(page.manifest)) }
      if (page.digest !== first.digest || JSON.stringify(page.manifest) !== JSON.stringify(first.manifest)) throw new Error('Imported archive changed during download.')
      for (const record of page.records) {
        bytes += new TextEncoder().encode(record.record).byteLength
        if (bytes > first.manifest.payloadBytes) throw new Error('Imported archive size did not match its manifest.')
        digests.push(archiveDigestLine(record, first.manifest.version))
        parts.push(encode(record))
      }
      after += page.records.length
      onProgress(after, first.manifest.recordCount)
    } while (!first || after < first.manifest.recordCount)
    if (bytes !== first.manifest.payloadBytes || await textDigest(digests.join('')) !== first.digest) throw new Error('Imported archive was incomplete. No download was created.')
    parts.push(encode({ complete: true, id: first.manifest.id, recordCount: after, payloadBytes: bytes }))
    owner.assertActive()
    return new Blob(parts, { type: 'application/x-ndjson' })
  }, owner.signal, 15 * 60_000, 'Imported archive download timed out. Retry; your project is unchanged.')
}
