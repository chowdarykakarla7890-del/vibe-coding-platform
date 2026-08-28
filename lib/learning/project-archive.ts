'use client'

import { z } from 'zod'
import { cloudOperation } from './cloud-request'
import { readWithDeadline } from '@/lib/abortable-read'
import { archivePageSchema, archiveReceiptSchema, verifyArchivePage } from '@/lib/projects/archive'
import { getApiErrorMessage } from '@/lib/api-error'
import { inspectArchive } from '@/lib/projects/archive-import'

function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve() }, ms)
    function cancel() { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(signal.reason) }
    signal.addEventListener('abort', cancel, { once: true })
  })
}

export async function downloadProjectArchive(projectId: string, signal: AbortSignal, onProgress: (saved: number, total: number, waitingSeconds?: number) => void) {
  // Independent account-bound cleanup survives user cancellation, but never
  // borrows a different account's cookies after sign-out/account switching.
  const owner = cloudOperation()
  let id = crypto.randomUUID()
  const parts: BlobPart[] = []
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) + '\n')
  const path = `/api/projects/${encodeURIComponent(projectId)}/archives`
  try {
    return await readWithDeadline(async deadline => {
      const operation = cloudOperation(deadline)
      owner.assertActive()
      const receipt = await operation.request(path, archiveReceiptSchema, 'POST', { archiveId: id })
      if (receipt.projectId !== projectId) throw new Error('The archive belongs to another project.')
      id = receipt.id
      const { formatVersion = 2, ...manifest } = receipt
      parts.push(encode({ format: 'codetutor-project-archive', version: formatVersion, ...manifest,
        scope: 'saved-project', includesUnsavedDrafts: false, includesLiveSandboxFiles: false }))
      let after = 0, bytes = 0, throttles = 0
      onProgress(0, receipt.recordCount)
      do {
        const response = await readWithDeadline(async pageSignal => {
          const response = await operation.fetch(`${path}/${id}?after=${after}`, { signal: pageSignal, cache: 'no-store' })
          const payload: unknown = await response.json().catch(() => undefined)
          operation.assertActive()
          return { status: response.status, retryAfter: response.headers.get('Retry-After'), payload }
        }, deadline, 20_000, 'Archive page timed out. Please retry.')
        if (response.status === 429 && throttles++ < 10) {
          const seconds = Math.max(1, Math.min(60, Number(response.retryAfter) || 1))
          onProgress(after, receipt.recordCount, seconds)
          await pause(seconds * 1000, deadline)
          continue
        }
        if (response.status !== 200) throw new Error(getApiErrorMessage(response.payload, 'The archive page could not be loaded. Retry the export.'))
        const page = archivePageSchema.parse(response.payload)
        bytes += await verifyArchivePage(receipt, page, after)
        operation.assertActive()
        if (bytes > receipt.payloadBytes) throw new Error('Archive size did not match its manifest.')
        for (const record of page.records) parts.push(encode(record))
        after += page.records.length
        onProgress(after, receipt.recordCount)
      } while (after < receipt.recordCount)
      if (bytes !== receipt.payloadBytes) throw new Error('Archive was incomplete. No backup was downloaded.')
      parts.push(encode({ complete: true, id, recordCount: after, payloadBytes: bytes }))
      operation.assertActive()
      const blob = new Blob(parts, { type: 'application/x-ndjson' })
      if (formatVersion === 3) await inspectArchive(blob, deadline)
      operation.assertActive()
      return blob
    }, AbortSignal.any([signal, owner.signal]), 10 * 60_000, 'The archive download timed out. Retry; your project has not changed.')
  } finally {
    // Only disposable staging records are removed, never the actual project.
    await readWithDeadline(async cleanupSignal => {
      const response = await owner.fetch(`${path}/${id}`, { method: 'DELETE', signal: cleanupSignal })
      if (!response.ok) throw new Error('Temporary archive cleanup failed.')
      z.object({ deleted: z.literal(true) }).parse(await response.json())
    }, owner.signal, 12_000, 'Archive cleanup timed out.').catch(() => undefined)
  }
}
