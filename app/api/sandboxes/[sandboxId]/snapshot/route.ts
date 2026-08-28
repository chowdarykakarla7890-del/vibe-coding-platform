import { ApiError, apiFailure, apiJson, requestBodyFailure } from '@/lib/server/api'
import { sandboxForRequest } from '@/lib/server/sandbox'
import { isSandboxUnavailableError } from '@/ai/sandbox'
import { hasSnapshotPathConflict, isSafeSnapshotPath, MAX_PROJECT_FILES, MAX_PROJECT_SNAPSHOT_BYTES, sourceByteLength } from '@/lib/learning/snapshots'
import { z } from 'zod'
import { readJsonBody } from '@/lib/request-body'
import { writeSandboxFilesForRequest } from '@/lib/server/source-files'
import { restorableSourceFileSchema } from '@/lib/source-version'
import { readSandboxTextFile, withSandboxFileRead } from '@/lib/server/sandbox-file-read'

export const maxDuration = 60

// Leave room below the hosting body limit. Recovery already sends 2 MiB
// batches; the server also admits bounded activity starter-file batches.
const MAX_TRANSFER_BYTES = 4 * 1024 * 1024
const restoreSchema = z.object({ files: z.array(restorableSourceFileSchema.strict()).max(MAX_PROJECT_FILES) }).strict()
  .refine(({ files }) => new Set(files.map(file => file.path)).size === files.length)
  .refine(({ files }) => !hasSnapshotPathConflict(files.map(file => file.path)))
const readSchema = z.object({ paths: z.array(z.string().min(1).max(240).refine(isSafeSnapshotPath)).max(MAX_PROJECT_FILES) }).strict()
  .refine(({ paths }) => !hasSnapshotPathConflict(paths))

function snapshotFailure(error: unknown, action: 'read' | 'restore', requestId: string) {
  if (error instanceof ApiError) return apiFailure(error, requestId)
  if (isSandboxUnavailableError(error)) return apiFailure(new ApiError(410, 'SANDBOX_EXPIRED', 'The sandbox has expired. Restore the project to continue.'), requestId)
  console.error(`Snapshot ${action} failed`, { requestId, errorName: error instanceof Error ? error.name : 'UnknownError' })
  return apiFailure(new ApiError(502, action === 'read' ? 'SNAPSHOT_READ_FAILED' : 'SNAPSHOT_RESTORE_FAILED',
    action === 'read' ? 'Could not read the sandbox snapshot.' : 'Could not restore files into the sandbox.'), requestId)
}

export async function POST(request: Request, { params }: { params: Promise<{ sandboxId: string }> }) {
  const requestId = crypto.randomUUID()
  try {
    const payload = await readJsonBody(request, 64 * 1024)
    if (!payload.ok) throw requestBodyFailure(payload.reason, 'INVALID_SNAPSHOT')
    const body = readSchema.safeParse(payload.data)
    if (!body.success) throw new ApiError(400, 'INVALID_SNAPSHOT', 'Snapshot paths are invalid.')
    const { sandboxId } = await params
    return await withSandboxFileRead(request.signal, async signal => {
      const sandbox = await sandboxForRequest(request, sandboxId, signal)
      signal.throwIfAborted()
      const files: Array<{ path: string; content: string }> = []
      const skipped: Array<{ path: string; reason: 'not-found' | 'too-large' | 'not-text' }> = []
      let totalBytes = 0
      let transferBytes = 0
      for (const path of new Set(body.data.paths)) {
        let content: string | null
        try { content = await readSandboxTextFile(sandbox, path, signal) }
        catch (error) {
          if (error instanceof ApiError && (error.code === 'FILE_TOO_LARGE' || error.code === 'FILE_NOT_TEXT')) {
            skipped.push({ path, reason: error.code === 'FILE_TOO_LARGE' ? 'too-large' : 'not-text' })
            continue
          }
          throw error
        }
        if (content === null) { skipped.push({ path, reason: 'not-found' }); continue }
        const file = { path, content }
        totalBytes += sourceByteLength(content)
        // Count escaped JSON, not just the source bytes. Do not silently return
        // a truncated backup when a caller needs to request smaller batches.
        transferBytes += sourceByteLength(JSON.stringify(file)) + 1
        if (totalBytes > MAX_PROJECT_SNAPSHOT_BYTES || transferBytes > MAX_TRANSFER_BYTES - 64 * 1024) {
          throw new ApiError(413, 'SNAPSHOT_TOO_LARGE', 'Request fewer files per snapshot batch. No saved source was changed.')
        }
        files.push(file)
      }
      signal.throwIfAborted()
      return apiJson({ files, totalBytes, skipped, complete: skipped.length === 0, requestId }, requestId)
    })
  } catch (error) { return snapshotFailure(error, 'read', requestId) }
}

export async function PUT(request: Request, { params }: { params: Promise<{ sandboxId: string }> }) {
  const requestId = crypto.randomUUID()
  try {
    const payload = await readJsonBody(request, MAX_TRANSFER_BYTES)
    if (!payload.ok) throw requestBodyFailure(payload.reason, 'INVALID_SNAPSHOT')
    const body = restoreSchema.safeParse(payload.data)
    if (!body.success) throw new ApiError(400, 'INVALID_SNAPSHOT', 'Snapshot files are invalid. Use unique, safe text-file paths.')
    const totalBytes = body.data.files.reduce((sum, file) => sum + sourceByteLength(file.content), 0)
    if (totalBytes > MAX_PROJECT_SNAPSHOT_BYTES) throw new ApiError(413, 'SNAPSHOT_TOO_LARGE', 'The snapshot exceeds 10 MB.')
    const { sandboxId } = await params
    if (request.signal.aborted) throw requestBodyFailure('aborted')
    // Once a durable write starts, keep its completion/receipt semantics. A
    // timed-out client must not turn a possibly committed save into success.
    if (body.data.files.length) await writeSandboxFilesForRequest(request, sandboxId, body.data.files)
    else await sandboxForRequest(request, sandboxId, request.signal)
    return apiJson({ restored: body.data.files.length, totalBytes, requestId }, requestId)
  } catch (error) { return snapshotFailure(error, 'restore', requestId) }
}
