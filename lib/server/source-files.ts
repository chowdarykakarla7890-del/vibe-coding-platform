import 'server-only'
import type { z } from 'zod'
import { z as schema } from 'zod'
import { sourceReceiptSchema, versionedSourceFileSchema } from '@/lib/source-version'
import { createAdminSupabaseClient } from '@/lib/supabase/server'
import { hasSnapshotPathConflict, MAX_PROJECT_FILES, MAX_PROJECT_SNAPSHOT_BYTES, sourceByteLength } from '@/lib/learning/snapshots'
import { ApiError, assertSameOrigin, requestBodyFailure, requireOwnedProject, requireOwnedSandbox, requireUser, type AuthContext } from './api'
import { getOwnedSandbox } from './sandbox'
import { consumeQuota } from './rate-limit'
import { applySandboxSource, SourceApplyError } from '@/lib/sandbox/source-apply'

export type SourceFile = z.infer<typeof versionedSourceFileSchema>
export const sourceBatchSchema = schema.array(versionedSourceFileSchema).min(1).max(MAX_PROJECT_FILES)
  .refine((files) => new Set(files.map((file) => file.path)).size === files.length)
  .refine((files) => !hasSnapshotPathConflict(files.map((file) => file.path)))
  .refine((files) => files.reduce((bytes, file) => bytes + sourceByteLength(file.content), 0) <= MAX_PROJECT_SNAPSHOT_BYTES)

/** One private CAS transaction. Direct client writes are revoked so stale REST
 * upserts cannot bypass checks. Ownership is verified here and inside the RPC. */
export async function saveOwnedSourceFiles(auth: AuthContext, projectId: string, input: SourceFile[], createOnly = false) {
  const parsed = sourceBatchSchema.safeParse(input)
  if (!parsed.success) throw new ApiError(400, 'INVALID_SOURCE', 'Use unique, safe source paths within the file and project limits.')
  await requireOwnedProject(projectId, auth)
  const { data, error } = await createAdminSupabaseClient().rpc('save_source_revision_batch', {
    p_user_id: auth.user.id, p_project_id: projectId, p_files: parsed.data.map((file) => ({ ...file, revision: file.revision ?? 0 })), p_create_only: createOnly,
  }).abortSignal(AbortSignal.timeout(15_000))
  if (error?.message === 'SOURCE_CONFLICT') throw new ApiError(409, 'SOURCE_CONFLICT', 'This file was changed elsewhere. Your draft is unchanged. Load the latest saved version and compare before saving again.')
  if (error?.message === 'SOURCE_REVISION_EXHAUSTED') throw new ApiError(409, 'SOURCE_REVISION_EXHAUSTED', 'This file reached its revision limit. Export your work and continue in a new project.')
  if (error?.message === 'SOURCE_PATH_CONFLICT') throw new ApiError(409, 'SOURCE_PATH_CONFLICT', 'A saved file already occupies a folder in this path, or this path already contains saved files. Choose another file path. Your saved source is unchanged.')
  if (error?.code === '23514') throw new ApiError(413, 'SOURCE_LIMIT', 'Keep this project under 200 files and 10 MB, with each file under 256 KB.')
  if (error?.code === '23505' && createOnly) throw new ApiError(409, 'FILE_ALREADY_EXISTS', 'A saved file already exists at this path.')
  if (error) throw new ApiError(502, 'SOURCE_SAVE_FAILED', 'Source could not be saved. No sandbox file was changed; retry the save.')
  const receipt = schema.array(sourceReceiptSchema).safeParse(data)
  const expectedPaths = new Set(parsed.data.map((file) => file.path))
  if (!receipt.success || receipt.data.length !== expectedPaths.size ||
    new Set(receipt.data.map((file) => file.path)).size !== expectedPaths.size ||
    receipt.data.some((file) => !expectedPaths.has(file.path))) {
    throw new ApiError(502, 'SOURCE_RECEIPT_INVALID', 'The source save could not be confirmed. Reload the saved version before retrying.')
  }
  return receipt.data
}

/**
 * Persist first: a VM write can only be acknowledged after its recovery source
 * is durable. A failed VM write must not roll back the only recoverable copy.
 * Account/project identity comes from the registered session, never file input.
 */
export async function writeOwnedSandboxFiles(
  auth: AuthContext,
  sandboxId: string,
  files: SourceFile[],
  options: { projectId?: string; createOnly?: boolean } = {},
) {
  const registration = await requireOwnedSandbox(sandboxId, auth)
  if (options.projectId && registration.project_id !== options.projectId) throw new ApiError(404, 'SANDBOX_NOT_FOUND', 'Sandbox not found in this project.')
  const sandbox = await getOwnedSandbox(auth, sandboxId, registration.project_id)
  if (options.createOnly) {
    // Explicit New file can recreate a deleted path, but still carries the
    // tombstone revision read before dispatch. Ordinary delayed saves cannot.
    const { data: deleted, error } = await auth.supabase.from('source_files').select('path,revision')
      .eq('project_id', registration.project_id).eq('user_id', auth.user.id).eq('deleted', true)
      .in('path', files.map((file) => file.path)).abortSignal(AbortSignal.timeout(10_000))
    if (error) throw new ApiError(502, 'SOURCE_READ_FAILED', 'Could not read file revisions. Retry creating this file.')
    const revisions = new Map(deleted.map((file) => [file.path, file.revision]))
    files = files.map((file) => ({ ...file, revision: revisions.get(file.path) ?? file.revision ?? 0 }))
    for (const file of files) {
      const existing = await sandbox.readFile({ path: file.path }, { signal: AbortSignal.timeout(10_000) })
      if (existing) {
        await existing[Symbol.asyncIterator]().return?.()
        throw new ApiError(409, 'FILE_ALREADY_EXISTS', 'A file already exists at this path.')
      }
    }
  }
  const receipts = await saveOwnedSourceFiles(auth, registration.project_id, files, options.createOnly)
  try {
    // Once the database accepted the write, finish applying it even if the
    // browser disconnects. This separate deadline still bounds the VM request.
    const revisions = new Map(receipts.map((receipt) => [receipt.path, receipt.revision]))
    await applySandboxSource(sandbox, files.map((file) => ({ path: file.path, content: file.content, revision: revisions.get(file.path)! })))
  } catch (error) {
    if (error instanceof SourceApplyError && error.code === 'SANDBOX_CLOSING') {
      throw new ApiError(409, 'SANDBOX_CLOSING', 'Your source is saved, but this sandbox is closing. Restore the saved version into a new sandbox; running files have not been replaced.')
    }
    if (error instanceof SourceApplyError && error.code === 'SOURCE_WORKSPACE_CHANGED') {
      throw new ApiError(409, 'SOURCE_WORKSPACE_CHANGED', 'Your source is saved, but this file was changed or deleted in the terminal. The terminal version has not been replaced. Review both versions before continuing.')
    }
    if (error instanceof SourceApplyError && error.code === 'SOURCE_SUPERSEDED') {
      throw new ApiError(409, 'SOURCE_SUPERSEDED', 'A newer saved version already reached the sandbox. Your draft is unchanged. Compare the latest version before saving again.')
    }
    throw new ApiError(502, 'SANDBOX_SOURCE_NOT_APPLIED', 'Your source is saved, but could not be applied to the sandbox. Retry the save or restore your project in a new sandbox.')
  }
  return receipts
}

export async function writeSandboxFilesForRequest(request: Request, sandboxId: string, files: SourceFile[], createOnly = false) {
  if (request.signal.aborted) throw requestBodyFailure('aborted')
  const auth = await requireUser(request)
  if (request.signal.aborted) throw requestBodyFailure('aborted')
  assertSameOrigin(request)
  await consumeQuota(auth.user.id, 'sandbox-mutation')
  if (request.signal.aborted) throw requestBodyFailure('aborted')
  // Do not race a durable write against caller cancellation. Past this point
  // its real receipt or conflict must settle; cancellation cannot roll it back.
  return writeOwnedSandboxFiles(auth, sandboxId, files, { createOnly })
}

/** Capture baselines before generation begins, not when its output arrives. */
export async function prepareOwnedFileWrites(auth: AuthContext, sandboxId: string, projectId: string, paths: string[]) {
  const registration = await requireOwnedSandbox(sandboxId, auth)
  if (registration.project_id !== projectId) throw new ApiError(404, 'SANDBOX_NOT_FOUND', 'Sandbox not found in this project.')
  const { data, error } = await auth.supabase.from('source_files').select('path,revision')
    .eq('project_id', projectId).eq('user_id', auth.user.id).in('path', paths).abortSignal(AbortSignal.timeout(10_000))
  if (error) throw new ApiError(502, 'SOURCE_READ_FAILED', 'Could not read saved file revisions. Retry generation.')
  const allowed = new Set(paths)
  const revisions = new Map(data.map((file) => [file.path, file.revision]))
  return async (files: Array<{ path: string; content: string }>) => {
    if (files.some((file) => !allowed.has(file.path))) throw new ApiError(400, 'INVALID_SOURCE', 'Generated files must match the requested paths.')
    const receipts = await writeOwnedSandboxFiles(auth, sandboxId, files.map((file) => ({ ...file, revision: revisions.get(file.path) ?? 0 })), { projectId })
    for (const receipt of receipts) revisions.set(receipt.path, receipt.revision)
  }
}
