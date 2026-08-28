import 'server-only'
import { createAdminSupabaseClient } from '@/lib/supabase/server'
import { ApiError, type AuthContext } from './api'
import { sourceImportReceiptSchema } from '@/lib/projects/source-import'
import type { Json } from '@/lib/supabase/database.types'

export async function ownedSourceImport(auth: AuthContext, id: string, action: 'begin' | 'read' | 'upload' | 'publish' | 'cancel', input: Json, signal: AbortSignal) {
  const result = await createAdminSupabaseClient().rpc('source_import_operation', {
    p_user_id: auth.user.id, p_import_id: id, p_action: action, p_input: input,
  }).abortSignal(AbortSignal.any([signal, AbortSignal.timeout(15_000)]))
  const failure = result.error?.message
  if (failure === 'IMPORT_NOT_FOUND') throw new ApiError(404, failure, 'Source import not found.')
  if (failure === 'IMPORT_EXPIRED' || failure === 'IMPORTED_PROJECT_DELETED') throw new ApiError(410, failure, 'This import is no longer available. The original export file has not changed.')
  if (failure === 'INVALID_IMPORT' || failure === 'IMPORT_DIGEST_MISMATCH') throw new ApiError(400, failure, 'The import contains invalid or corrupted source data.')
  if (failure === 'IMPORT_LIMIT' || result.error?.code === '23514') throw new ApiError(413, 'IMPORT_LIMIT', 'Keep imports under 200 files and 10 MB of source, with each file under 256 KB.')
  if (failure === 'IMPORT_IN_PROGRESS') throw new ApiError(409, failure, 'Another source import is in progress. Finish or cancel it before starting another.')
  if (['IMPORT_CONFLICT', 'IMPORT_INCOMPLETE', 'IMPORT_CANCELLED', 'IMPORT_ALREADY_PUBLISHED', 'SOURCE_PATH_CONFLICT'].includes(failure ?? '')) {
    throw new ApiError(409, failure!, 'The source import could not continue. Check its status or retry using the original export file. Existing projects are unchanged.')
  }
  if (result.error) throw new ApiError(502, 'IMPORT_UNCONFIRMED', 'The import could not be confirmed. Check its status before retrying; no existing project was removed.')
  const receipt = sourceImportReceiptSchema.safeParse(result.data)
  if (!receipt.success || receipt.data.id !== id) throw new ApiError(502, 'IMPORT_RECEIPT_INVALID', 'The import receipt could not be verified. Check its status before retrying.')
  // Return the wire schema, not its transformed LearningProject shape.
  return result.data
}
