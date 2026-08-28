import { z } from 'zod'
import { ApiError, apiFailure, apiJson, assertSameOrigin, parseBody, requireUser } from '@/lib/server/api'
import { MAX_ARCHIVE_UPLOAD_BYTES, archiveImportUploadSchema, validateImportedEnvelope } from '@/lib/projects/archive-import'
import { ownedArchiveImport } from '@/lib/server/archive-import'
import { consumeQuota } from '@/lib/server/rate-limit'

type Context = { params: Promise<{ importId: string }> }
async function operation(request: Request, context: Context, action: 'read' | 'upload' | 'publish' | 'cancel') {
  const requestId = crypto.randomUUID()
  try {
    const auth = await requireUser(request)
    if (action !== 'read') assertSameOrigin(request)
    const { importId } = await context.params
    if (!z.string().uuid().safeParse(importId).success) throw new ApiError(400, 'INVALID_IMPORT_ID', 'Choose a valid archive import.')
    const input = action === 'upload' ? await parseBody(request, archiveImportUploadSchema, MAX_ARCHIVE_UPLOAD_BYTES)
      : action === 'publish' ? await parseBody(request, z.object({}).strict()) : {}
    const quota = await consumeQuota(auth.user.id, 'import-request')
    if (action === 'upload') {
      try { for (const record of archiveImportUploadSchema.parse(input).records) { request.signal.throwIfAborted(); await validateImportedEnvelope(record) } }
      catch { throw new ApiError(400, 'INVALID_ARCHIVE_RECORD', 'The archive contains an invalid or corrupted record. Choose the original export file.') }
    }
    return apiJson(await ownedArchiveImport(auth, importId, action, input, request.signal), requestId, 200, quota)
  } catch (error) { return apiFailure(error, requestId) }
}
export const GET = (request: Request, context: Context) => operation(request, context, 'read')
export const PUT = (request: Request, context: Context) => operation(request, context, 'upload')
export const POST = (request: Request, context: Context) => operation(request, context, 'publish')
export const DELETE = (request: Request, context: Context) => operation(request, context, 'cancel')
