'use client'

import { z } from 'zod'
import { cloudOperation } from './cloud-request'
import { parseProjectExport } from './local-db'
import { readLocalPreference, writeLocalPreference } from '@/lib/local-preferences'
import { readWithDeadline } from '@/lib/abortable-read'
import { getApiErrorMessage } from '@/lib/api-error'
import { prepareSourceImport, sourceImportBatches, sourceImportReceiptSchema, type SourceImportReceipt } from '@/lib/projects/source-import'

const pendingSchema = z.object({ id: z.string().uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
class ImportRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}
function key(userId: string) { return `codetutor-source-import:${userId}` }
function pending(userId: string) {
  try { return pendingSchema.parse(JSON.parse(readLocalPreference(key(userId)) ?? 'null')) } catch { return undefined }
}

async function request(operation: ReturnType<typeof cloudOperation>, id: string | undefined, method: string, body?: unknown) {
  return readWithDeadline(async signal => {
    const response = await operation.fetch(`/api/projects/imports${id ? `/${id}` : ''}`, {
      method, signal, cache: 'no-store', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    })
    const value: unknown = await response.json().catch(() => undefined)
    operation.assertActive()
    if (!response.ok) throw new ImportRequestError(getApiErrorMessage(value, 'Source import could not be confirmed. Retry with the same export file.'), response.status)
    const receipt = sourceImportReceiptSchema.parse(value)
    if (id && receipt.id !== id) throw new Error('Source import receipt belongs to a different upload.')
    return receipt
  }, operation.signal, 20_000, 'Source import timed out. Retry with the same export file; existing work is unchanged.')
}

export async function checkPendingSourceImport(signal: AbortSignal) {
  const operation = cloudOperation(signal)
  const saved = pending(operation.userId)
  if (!saved) return undefined
  return request(operation, saved.id, 'GET')
}

export async function cancelPendingSourceImport(signal: AbortSignal) {
  const operation = cloudOperation(signal)
  const saved = pending(operation.userId)
  if (!saved) return undefined
  // Cancel fences pending publication. If publication won, the server returns
  // that project intact. Never DELETE /api/projects as import cleanup.
  let receipt: SourceImportReceipt
  try { receipt = await request(operation, saved.id, 'DELETE') }
  catch (error) {
    if (error instanceof ImportRequestError && (error.status === 404 || error.status === 410)) {
      operation.assertActive(); writeLocalPreference(key(operation.userId), null); return undefined
    }
    throw error
  }
  operation.assertActive()
  if (receipt.state === 'cancelled') writeLocalPreference(key(operation.userId), null)
  return receipt
}

export function acknowledgeSourceImport(id: string) {
  const operation = cloudOperation()
  if (pending(operation.userId)?.id === id) writeLocalPreference(key(operation.userId), null)
}

/** Pause keeps a resumable staging ID; neither timeout nor unmount is a rollback.
 * Existing device source exports remain read-only throughout this operation.
 */
export async function importSourceProject(input: unknown, signal: AbortSignal, onProgress: (receipt: SourceImportReceipt) => void = () => {}) {
  const owner = cloudOperation(signal)
  const data = parseProjectExport(input)
  return readWithDeadline(async deadline => {
    const operation = cloudOperation(deadline)
    const { files, digest, sourceBytes } = await prepareSourceImport(data.files.map(({ path, content }) => ({ path, content })))
    owner.assertActive(); operation.assertActive()
    const previous = pending(owner.userId)
    if (previous && previous.digest !== digest) throw new Error('Another import is pending. Resume it with the original export file or cancel it first.')
    const id = previous?.id ?? crypto.randomUUID()
    if (!writeLocalPreference(key(owner.userId), JSON.stringify({ id, digest }))) throw new Error('Allow browser storage before importing so an interrupted upload can be recovered.')
    let receipt = await request(operation, undefined, 'POST', { id, title: `${data.project.title} (imported)`.slice(0, 80),
      language: data.project.language, fileCount: files.length, sourceBytes, digest })
    const check = (value: SourceImportReceipt) => {
      if (value.id !== id || value.digest !== digest || value.fileCount !== files.length || value.sourceBytes !== sourceBytes) throw new Error('Source import receipt did not match the export file.')
      if (value.state === 'cancelled') throw new Error('This import was cancelled. Choose the export again to start a new import.')
      onProgress(value)
    }
    check(receipt)
    if (receipt.state !== 'published') {
      for (const batch of sourceImportBatches(files)) {
        receipt = await request(operation, id, 'PUT', { files: batch })
        check(receipt)
      }
      // Retrying this commit (including after a lost response) returns the
      // same published project. Its current source is never overwritten.
      receipt = await request(operation, id, 'POST', {})
      check(receipt)
    }
    if (receipt.state !== 'published' || !receipt.project) throw new Error('The complete source import has not been published. Retry with the same export file.')
    operation.assertActive()
    return receipt.project
  }, owner.signal, 5 * 60_000, 'Import paused after five minutes. Resume with the same export file; existing projects are unchanged.')
}
