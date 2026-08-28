import 'server-only'
import { createAdminSupabaseClient } from '@/lib/supabase/server'
import { ApiError, type AuthContext } from './api'
import { archiveImportReceiptSchema, importedArchivePageSchema } from '@/lib/projects/archive-import'
import type { Json } from '@/lib/supabase/database.types'

function archiveImportFailure(error: { message: string; code?: string } | null) {
  if (!error) return
  const failure = error.message
  if (failure === 'ARCHIVE_IMPORT_NOT_FOUND') throw new ApiError(404, failure, 'Archive import not found.')
  if (failure === 'ARCHIVE_IMPORT_EXPIRED' || failure === 'IMPORTED_PROJECT_DELETED') throw new ApiError(410, failure, 'This import is no longer available. Your original archive has not changed.')
  if (['INVALID_ARCHIVE_IMPORT', 'INVALID_ARCHIVE_SOURCE', 'ARCHIVE_DIGEST_MISMATCH'].includes(failure)) throw new ApiError(400, failure, 'The archive contains invalid or corrupted records. No existing project was changed.')
  if (failure === 'ARCHIVE_STORAGE_LIMIT') throw new ApiError(413, failure, 'Archived evidence is limited to 512 MB per account. Export and remove an imported project before importing another archive.')
  if (failure === 'ARCHIVE_IMPORT_LIMIT' || error.code === '23514') throw new ApiError(413, 'ARCHIVE_IMPORT_LIMIT', 'The archive or its source exceeds the supported limits.')
  if (failure === 'ARCHIVE_IMPORT_IN_PROGRESS') throw new ApiError(409, failure, 'Another archive import is pending. Resume or cancel it first.')
  if (['ARCHIVE_IMPORT_CONFLICT', 'ARCHIVE_IMPORT_INCOMPLETE', 'ARCHIVE_IMPORT_CANCELLED', 'ARCHIVE_IMPORT_ALREADY_PUBLISHED', 'SOURCE_PATH_CONFLICT'].includes(failure) || error.code === '23505') {
    throw new ApiError(409, 'ARCHIVE_IMPORT_CONFLICT', 'The archive import could not continue. Check its status or retry with the original file. Existing projects are unchanged.')
  }
  throw new ApiError(502, 'ARCHIVE_IMPORT_UNCONFIRMED', 'The import could not be confirmed. Check its status before retrying; no existing project was removed.')
}

export async function ownedArchiveImport(auth: AuthContext, id: string, action: 'begin' | 'read' | 'upload' | 'publish' | 'cancel', input: Json, signal: AbortSignal) {
  const result = await createAdminSupabaseClient().rpc('project_archive_import_operation', {
    p_user_id: auth.user.id, p_import_id: id, p_action: action, p_input: input,
  }).abortSignal(AbortSignal.any([signal, AbortSignal.timeout(15_000)]))
  archiveImportFailure(result.error)
  const receipt = archiveImportReceiptSchema.safeParse(result.data)
  if (!receipt.success || receipt.data.id !== id) throw new ApiError(502, 'ARCHIVE_IMPORT_RECEIPT_INVALID', 'The import receipt could not be verified. Check its status before retrying.')
  return result.data
}

export async function ownedImportedArchive(auth: AuthContext, projectId: string, after: number, signal: AbortSignal) {
  const result = await createAdminSupabaseClient().rpc('read_imported_project_archive', {
    p_user_id: auth.user.id, p_project_id: projectId, p_after: after,
  }).abortSignal(AbortSignal.any([signal, AbortSignal.timeout(15_000)]))
  archiveImportFailure(result.error)
  const page = importedArchivePageSchema.safeParse(result.data)
  if (!page.success || page.data.id !== projectId) throw new ApiError(502, 'ARCHIVE_IMPORT_RECEIPT_INVALID', 'Imported history could not be verified. Please retry.')
  return result.data
}
