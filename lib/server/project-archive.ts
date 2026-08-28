import 'server-only'
import { z } from 'zod'
import { ApiError, type AuthContext } from './api'
import { createAdminSupabaseClient } from '@/lib/supabase/server'
import { CURATED_ACTIVITIES } from '@/lib/learning/catalog'
import { archivePageSchema, archiveReceiptSchema } from '@/lib/projects/archive'

function failure(error: { code?: string; message?: string } | null) {
  if (!error) return
  if (['PROJECT_NOT_FOUND', 'ARCHIVE_NOT_FOUND'].includes(error.message ?? '')) throw new ApiError(404, 'ARCHIVE_NOT_FOUND', 'Project archive not found.')
  if (error.message === 'ARCHIVE_IN_PROGRESS') throw new ApiError(409, 'ARCHIVE_IN_PROGRESS', 'Another project has an export in progress. Finish or cancel it before exporting this project.')
  if (error.message === 'ARCHIVE_EXPIRED') throw new ApiError(410, 'ARCHIVE_EXPIRED', 'This temporary export expired. Start a new export; your project has not changed.')
  if (error.message === 'INVALID_ARCHIVE_CURSOR') throw new ApiError(400, 'INVALID_ARCHIVE_CURSOR', 'Choose a valid archive page.')
  if (error.code === '23514') throw new ApiError(413, 'ARCHIVE_LIMIT', 'The complete archive exceeds the export limits. No partial backup was created and no project data was removed.')
  throw new ApiError(502, 'ARCHIVE_UNAVAILABLE', 'The archive operation could not be confirmed. Your original project has not been changed.')
}

export function assertArchiveId(id: string) {
  if (!z.string().uuid().safeParse(id).success) throw new ApiError(400, 'INVALID_ARCHIVE_ID', 'Choose a valid project archive.')
}

export async function createOwnedArchive(auth: AuthContext, projectId: string, id: string, signal: AbortSignal) {
  const result = await createAdminSupabaseClient().rpc('create_project_archive', {
    p_user_id: auth.user.id, p_project_id: projectId, p_archive_id: id, p_catalog: CURATED_ACTIVITIES,
  }).abortSignal(AbortSignal.any([signal, AbortSignal.timeout(25_000)]))
  failure(result.error)
  const receipt = archiveReceiptSchema.safeParse(result.data)
  if (!receipt.success || receipt.data.projectId !== projectId) throw new ApiError(502, 'INVALID_ARCHIVE_RECEIPT', 'The archive could not be verified. Retry without deleting your project.')
  return receipt.data
}

export async function readOwnedArchive(auth: AuthContext, projectId: string, id: string, after: number, signal: AbortSignal) {
  const result = await createAdminSupabaseClient().rpc('read_project_archive', {
    p_user_id: auth.user.id, p_project_id: projectId, p_archive_id: id, p_after: after,
  }).abortSignal(AbortSignal.any([signal, AbortSignal.timeout(15_000)]))
  failure(result.error)
  const page = archivePageSchema.safeParse(result.data)
  if (!page.success || page.data.id !== id) throw new ApiError(502, 'INVALID_ARCHIVE_PAGE', 'The archive page could not be verified. Retry the export.')
  return page.data
}

export async function deleteOwnedArchive(auth: AuthContext, projectId: string, id: string, signal: AbortSignal) {
  const result = await createAdminSupabaseClient().rpc('delete_project_archive', {
    p_user_id: auth.user.id, p_project_id: projectId, p_archive_id: id,
  }).abortSignal(AbortSignal.any([signal, AbortSignal.timeout(10_000)]))
  failure(result.error)
  if (result.data !== true) throw new ApiError(502, 'ARCHIVE_CLEANUP_UNCONFIRMED', 'Temporary export cleanup could not be confirmed. Your original project is unchanged.')
  return { deleted: true as const }
}
