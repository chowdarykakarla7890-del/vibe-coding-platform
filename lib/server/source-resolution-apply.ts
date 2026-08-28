import 'server-only'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { ApiError, requireOwnedProject, requireOwnedSandbox, type AuthContext } from './api'
import { getOwnedSandbox } from './sandbox'
import { assertConflictId } from './source-recovery'
import { applySandboxResolution } from '@/lib/sandbox/source-resolution-apply'
import { SourceApplyError } from '@/lib/sandbox/source-apply'
import { applyResolutionRequestSchema, type ApplyResolutionReceipt } from '@/lib/source-recovery'
import { isSafeSnapshotPath, MAX_SOURCE_FILE_BYTES, sourceByteLength } from '@/lib/learning/snapshots'

const sourceSchema = z.object({ revision: z.number().int().positive(), content: z.string().refine(s => sourceByteLength(s) <= MAX_SOURCE_FILE_BYTES), deleted: z.boolean() })

export async function applyOwnedSourceResolution(auth: AuthContext, projectId: string, id: string, input: z.infer<typeof applyResolutionRequestSchema>): Promise<ApplyResolutionReceipt> {
  await requireOwnedProject(projectId, auth)
  assertConflictId(id)
  const registration = await requireOwnedSandbox(input.sandboxId, auth)
  if (registration.project_id !== projectId) throw new ApiError(404, 'SANDBOX_NOT_FOUND', 'Sandbox not found in this project.')
  const signal = AbortSignal.timeout(15_000)
  const { data: item, error } = await auth.supabase.from('source_capture_conflicts')
    .select('id,path,resolved_at,resolution_revision,resolution_deleted,captured_content')
    .eq('project_id', projectId).eq('user_id', auth.user.id).eq('id', id).abortSignal(signal).maybeSingle()
  if (error) throw new ApiError(502, 'SOURCE_REVIEW_UNAVAILABLE', 'Could not read this review. No application was started.')
  if (!item) throw new ApiError(404, 'SOURCE_REVIEW_NOT_FOUND', 'Source review not found.')
  if (!item.resolved_at || item.resolution_revision !== input.revision || !isSafeSnapshotPath(item.path)) throw new ApiError(409, 'SOURCE_REVIEW_CHANGED', 'Reload and resolve this review before applying it.')
  const readCurrent = async () => {
    const { data, error: readError } = await auth.supabase.from('source_files').select('content,revision,deleted')
      .eq('project_id', projectId).eq('user_id', auth.user.id).eq('path', item.path).abortSignal(AbortSignal.timeout(10_000)).maybeSingle()
    if (readError) throw new ApiError(502, 'SOURCE_READ_FAILED', 'Could not confirm the saved source. Retry to check application; saved copies are unchanged.')
    const parsed = data === null ? null : sourceSchema.safeParse(data)
    if (parsed && !parsed.success) throw new ApiError(502, 'SOURCE_READ_FAILED', 'The saved source is invalid. Download the review copies before continuing.')
    const source = parsed?.success ? parsed.data : { revision: 0, deleted: true, content: '' }
    if (source.revision !== item.resolution_revision || source.deleted !== item.resolution_deleted) throw new ApiError(409, 'SOURCE_SUPERSEDED', 'Saved source changed after this resolution. This old review cannot overwrite the newer version.')
    return source
  }
  const source = await readCurrent()
  const vm = await getOwnedSandbox(auth, input.sandboxId, projectId)
  try {
    await applySandboxResolution(vm, { path: item.path, content: source.deleted ? null : source.content, revision: source.revision,
      expectedDigest: item.captured_content === null ? null : createHash('sha256').update(item.captured_content).digest('hex') })
  } catch (error) {
    if (error instanceof SourceApplyError) {
      if (error.code === 'SOURCE_COMMANDS_RUNNING') throw new ApiError(409, error.code, 'Stop running terminal commands and the preview server, then retry. No file was replaced.')
      if (error.code === 'SOURCE_WORKSPACE_CHANGED') throw new ApiError(409, error.code, 'The sandbox file changed after this comparison. Its newer contents were not replaced. Review the new terminal changes before applying a resolution.')
      if (error.code === 'SANDBOX_CLOSING') throw new ApiError(409, error.code, 'The sandbox is closing. Your resolution remains saved; restore it into a new sandbox.')
      if (error.code === 'SOURCE_SUPERSEDED' || error.code === 'SOURCE_REVISION_MISMATCH') throw new ApiError(409, 'SOURCE_SUPERSEDED', 'A newer version already reached the sandbox. Reload and compare before continuing.')
      if (error.code === 'SOURCE_APPLY_BUSY') throw new ApiError(409, error.code, 'Another source operation is in progress. Retry application when it finishes.')
    }
    throw new ApiError(502, 'SOURCE_APPLICATION_UNCONFIRMED', 'Could not confirm application to the sandbox. Your resolution is saved. Retry to check and apply the same revision safely.')
  }
  // Do not describe an older resolution as current if a competing database
  // save completed while the VM request was in flight. The journal fences
  // ordering independently of this check; no DB lock spans the network call.
  await readCurrent()
  await requireOwnedSandbox(input.sandboxId, auth)
  return { id, sandboxId: input.sandboxId, path: item.path, revision: source.revision, deleted: source.deleted }
}
