import { apiFailure, apiJson, assertSameOrigin, parseBody, requireUser } from '@/lib/server/api'
import { beginSourceImportSchema } from '@/lib/projects/source-import'
import { ownedSourceImport } from '@/lib/server/source-import'
import { consumeQuota } from '@/lib/server/rate-limit'

export async function POST(request: Request) {
  const requestId = crypto.randomUUID()
  try {
    const auth = await requireUser(request)
    assertSameOrigin(request)
    const { id, ...input } = await parseBody(request, beginSourceImportSchema)
    const quota = await consumeQuota(auth.user.id, 'import-create')
    return apiJson(await ownedSourceImport(auth, id, 'begin', input, request.signal), requestId, 201, quota)
  } catch (error) { return apiFailure(error, requestId) }
}
