import { ApiError, apiFailure, apiJson, assertSameOrigin, parseBody, requireOwnedProject, requireUser } from '@/lib/server/api'
import { consumeQuota } from '@/lib/server/rate-limit'
import { assertConflictId, resolveOwnedSourceConflict } from '@/lib/server/source-recovery'
import { resolutionRequestSchema } from '@/lib/source-recovery'

type Context = { params: Promise<{ projectId: string; conflictId: string }> }
export async function GET(request: Request, context: Context) {
  const requestId = crypto.randomUUID()
  try {
    const auth = await requireUser(request)
    const { projectId, conflictId } = await context.params
    await requireOwnedProject(projectId, auth)
    assertConflictId(conflictId)
    const quota = await consumeQuota(auth.user.id, 'source-read')
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)])
    const { data: item, error } = await auth.supabase.from('source_capture_conflicts')
      .select('id,path,reason,created_at,resolved_at,captured_content,reviewed_content,reviewed_revision,resolution_choice,resolution_revision,resolution_deleted')
      .eq('project_id', projectId).eq('user_id', auth.user.id).eq('id', conflictId).abortSignal(signal).maybeSingle()
    if (error) throw new ApiError(502, 'SOURCE_REVIEW_UNAVAILABLE', 'This source review could not be loaded. Retry without clearing saved data.')
    if (!item) throw new ApiError(404, 'SOURCE_REVIEW_NOT_FOUND', 'Source review not found.')
    const { data: source, error: sourceError } = await auth.supabase.from('source_files').select('content,revision,deleted')
      .eq('project_id', projectId).eq('user_id', auth.user.id).eq('path', item.path).abortSignal(signal).maybeSingle()
    if (sourceError) throw new ApiError(502, 'SOURCE_READ_FAILED', 'The latest saved revision could not be loaded.')
    // Two bounded versions only; no original source, prompts, or capabilities
    // are included in list responses. Resolved reviews retain the reviewed copy.
    return apiJson({ conflict: { id: item.id, path: item.path, reason: item.reason, createdAt: item.created_at, resolvedAt: item.resolved_at, captured: item.captured_content },
      current: item.resolved_at ? { content: item.reviewed_content, revision: item.reviewed_revision }
        : { content: source && !source.deleted ? source.content : null, revision: source?.revision ?? 0 },
      resolution: item.resolved_at ? { id: item.id, path: item.path, choice: item.resolution_choice, revision: item.resolution_revision, deleted: item.resolution_deleted } : null,
    }, requestId, 200, quota)
  } catch (error) { return apiFailure(error, requestId) }
}

export async function POST(request: Request, context: Context) {
  const requestId = crypto.randomUUID()
  try {
    const auth = await requireUser(request)
    assertSameOrigin(request)
    const { projectId, conflictId } = await context.params
    await requireOwnedProject(projectId, auth)
    assertConflictId(conflictId)
    const input = await parseBody(request, resolutionRequestSchema, 2 * 1024 * 1024)
    const quota = await consumeQuota(auth.user.id, 'source-write')
    const receipt = await resolveOwnedSourceConflict(auth, projectId, conflictId, input)
    // A live workspace can have newer unrecorded writes. Resolution never
    // force-overwrites a VM: the UI explicitly describes saved-source scope.
    return apiJson(receipt, requestId, 200, quota)
  } catch (error) { return apiFailure(error, requestId) }
}
