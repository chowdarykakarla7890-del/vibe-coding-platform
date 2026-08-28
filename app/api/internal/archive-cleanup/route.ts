import { timingSafeEqual } from 'node:crypto'
import { ApiError, apiFailure, apiJson } from '@/lib/server/api'
import { createAdminSupabaseClient } from '@/lib/supabase/server'

export const maxDuration = 30
export async function GET(request: Request) {
  const requestId = crypto.randomUUID()
  try {
    const secret = process.env.CRON_SECRET
    if (!secret || secret.length < 32) throw new ApiError(503, 'ARCHIVE_CLEANUP_UNCONFIGURED', 'Archive cleanup is not configured.')
    const provided = Buffer.from(request.headers.get('authorization') ?? '')
    const expected = Buffer.from(`Bearer ${secret}`)
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new ApiError(401, 'WORKER_AUTH_REQUIRED', 'Worker authorization is required.')
    const admin = createAdminSupabaseClient()
    const [{ data, error }, imports, archiveImports] = await Promise.all([
      admin.rpc('purge_project_archives').abortSignal(AbortSignal.timeout(20_000)),
      admin.rpc('purge_source_imports').abortSignal(AbortSignal.timeout(20_000)),
      admin.rpc('purge_project_archive_imports').abortSignal(AbortSignal.timeout(20_000)),
    ])
    if (error || !Number.isInteger(data) || data! < 0 || data! > 5) throw new ApiError(502, 'ARCHIVE_CLEANUP_FAILED', 'Temporary archive cleanup could not be confirmed.')
    if (imports.error || !Number.isInteger(imports.data) || imports.data! < 0 || imports.data! > 5) throw new ApiError(502, 'IMPORT_CLEANUP_FAILED', 'Temporary import cleanup could not be confirmed.')
    if (archiveImports.error || !Number.isInteger(archiveImports.data) || archiveImports.data! < 0 || archiveImports.data! > 5) throw new ApiError(502, 'IMPORT_CLEANUP_FAILED', 'Temporary archive import cleanup could not be confirmed.')
    return apiJson({ removed: data, importsRemoved: imports.data, archiveImportsRemoved: archiveImports.data }, requestId)
  } catch (error) { return apiFailure(error, requestId) }
}
