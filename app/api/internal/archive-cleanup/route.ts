import { ApiError, apiFailure, apiJson } from '@/lib/server/api'
import { createAdminSupabaseClient } from '@/lib/supabase/server'
import { observeWorker, requireWorkerAuthorization } from '@/lib/server/worker-health'
import { awaitMutationReceipt } from '@/lib/mutation-receipt'

export const maxDuration = 30
export async function GET(request: Request) {
  const requestId = crypto.randomUUID()
  try {
    requireWorkerAuthorization(request, 'ARCHIVE_CLEANUP_UNCONFIGURED', 'Archive cleanup is not configured.')
    const result = await observeWorker('archive-cleanup', requestId, async () => {
      const admin = createAdminSupabaseClient()
      const [{ data, error }, imports, archiveImports] = await awaitMutationReceipt(async signal => await Promise.all([
        admin.rpc('purge_project_archives').abortSignal(signal),
        admin.rpc('purge_source_imports').abortSignal(signal),
        admin.rpc('purge_project_archive_imports').abortSignal(signal),
      ]), new AbortController().signal, 20_000, 'Archive cleanup receipt timed out.')
      if (error || !Number.isInteger(data) || data! < 0 || data! > 5) throw new ApiError(502, 'ARCHIVE_CLEANUP_FAILED', 'Temporary archive cleanup could not be confirmed.')
      if (imports.error || !Number.isInteger(imports.data) || imports.data! < 0 || imports.data! > 5) throw new ApiError(502, 'IMPORT_CLEANUP_FAILED', 'Temporary import cleanup could not be confirmed.')
      if (archiveImports.error || !Number.isInteger(archiveImports.data) || archiveImports.data! < 0 || archiveImports.data! > 5) throw new ApiError(502, 'IMPORT_CLEANUP_FAILED', 'Temporary archive import cleanup could not be confirmed.')
      return { removed: data, importsRemoved: imports.data, archiveImportsRemoved: archiveImports.data }
    }, () => true)
    return apiJson(result, requestId)
  } catch (error) { return apiFailure(error, requestId) }
}
