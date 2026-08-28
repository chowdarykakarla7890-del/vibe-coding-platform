import 'server-only'
import { z } from 'zod'
import { ApiError, type AuthContext } from './api'
import { createAdminSupabaseClient } from '@/lib/supabase/server'
import { resolutionReceiptSchema, type ResolutionRequest } from '@/lib/source-recovery'

export function assertConflictId(id: string) {
  if (!z.string().uuid().safeParse(id).success) throw new ApiError(400, 'INVALID_CONFLICT_ID', 'Choose a valid source review.')
}

export async function retryOwnedSourceCaptures(auth: AuthContext, projectId: string) {
  const { data, error } = await createAdminSupabaseClient().rpc('retry_source_captures', {
    p_user_id: auth.user.id, p_project_id: projectId,
  }).abortSignal(AbortSignal.timeout(15_000))
  if (error?.message === 'PROJECT_NOT_FOUND') throw new ApiError(404, 'PROJECT_NOT_FOUND', 'Project not found.')
  if (error?.message === 'SANDBOX_EXPIRED') throw new ApiError(410, 'SANDBOX_EXPIRED', 'This sandbox stopped before capture could resume. Saved source and review copies are unchanged.')
  if (error || !z.number().int().min(0).max(10).safeParse(data).success) throw new ApiError(502, 'SOURCE_CAPTURE_RETRY_FAILED', 'Could not confirm the background-save retry. Refresh its status before trying again.')
  return data as number
}

export async function resolveOwnedSourceConflict(auth: AuthContext, projectId: string, id: string, input: ResolutionRequest) {
  const { data, error } = await createAdminSupabaseClient().rpc('resolve_source_conflict', {
    p_user_id: auth.user.id, p_project_id: projectId, p_conflict_id: id, p_revision: input.revision,
    p_choice: input.choice, p_content: input.choice === 'merged' ? input.content : undefined,
  }).abortSignal(AbortSignal.timeout(15_000))
  if (error?.message === 'SOURCE_CONFLICT') throw new ApiError(409, 'SOURCE_CONFLICT', 'Saved source changed after you opened this review. Reload the comparison; your merge draft is kept.')
  if (error?.message === 'SOURCE_REVIEW_RESOLVED') throw new ApiError(409, 'SOURCE_REVIEW_RESOLVED', 'This conflict was already resolved differently. Reload the review before continuing.')
  if (error?.message === 'SOURCE_REVIEW_NOT_FOUND' || error?.message === 'PROJECT_NOT_FOUND') throw new ApiError(404, 'SOURCE_REVIEW_NOT_FOUND', 'Source review not found.')
  if (error?.message === 'SOURCE_PATH_CONFLICT') throw new ApiError(409, 'SOURCE_PATH_CONFLICT', 'This path conflicts with a saved file or folder. Export this copy and resolve the other path first.')
  if (error?.message === 'SOURCE_REVISION_EXHAUSTED') throw new ApiError(409, 'SOURCE_REVISION_EXHAUSTED', 'This file reached its revision limit. Download the preserved copies and continue in a new project.')
  if (error?.code === '23514') throw new ApiError(413, 'SOURCE_LIMIT', 'This resolution exceeds the project source limit. Your preserved copies are unchanged.')
  if (error) throw new ApiError(502, 'SOURCE_RESOLUTION_FAILED', 'Could not confirm this resolution. Retry the same choice; preserved copies have not been removed.')
  const receipt = resolutionReceiptSchema.safeParse(data)
  if (!receipt.success || receipt.data.id !== id || receipt.data.choice !== input.choice || receipt.data.revision < input.revision) throw new ApiError(502, 'INVALID_RESOLUTION_RECEIPT', 'Could not confirm this resolution. Reload its status before trying again.')
  return receipt.data
}
