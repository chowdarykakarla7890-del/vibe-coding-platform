import { z } from 'zod'
import { ApiError, apiFailure, apiJson, assertSameOrigin, parseBody, requireUser } from '@/lib/server/api'
import { MAX_SOURCE_IMPORT_REQUEST_BYTES, sourceImportBatchSchema } from '@/lib/projects/source-import'
import { ownedSourceImport } from '@/lib/server/source-import'
import { consumeQuota } from '@/lib/server/rate-limit'

type Context = { params: Promise<{ importId: string }> }
async function operation(request: Request, context: Context, action: 'read' | 'upload' | 'publish' | 'cancel') {
  const requestId = crypto.randomUUID()
  try {
    const auth = await requireUser(request)
    if (action !== 'read') assertSameOrigin(request)
    const { importId } = await context.params
    if (!z.string().uuid().safeParse(importId).success) throw new ApiError(400, 'INVALID_IMPORT_ID', 'Choose a valid source import.')
    const input = action === 'upload' ? await parseBody(request, sourceImportBatchSchema, MAX_SOURCE_IMPORT_REQUEST_BYTES)
      : action === 'publish' ? await parseBody(request, z.object({}).strict()) : {}
    const quota = await consumeQuota(auth.user.id, 'import-request')
    return apiJson(await ownedSourceImport(auth, importId, action, input, request.signal), requestId, 200, quota)
  } catch (error) { return apiFailure(error, requestId) }
}
export const GET = (request: Request, context: Context) => operation(request, context, 'read')
export const PUT = (request: Request, context: Context) => operation(request, context, 'upload')
export const POST = (request: Request, context: Context) => operation(request, context, 'publish')
export const DELETE = (request: Request, context: Context) => operation(request, context, 'cancel')
