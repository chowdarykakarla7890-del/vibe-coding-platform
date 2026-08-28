import { apiFailure, apiJson, assertSameOrigin, parseBody, requireUser } from '@/lib/server/api'
import { beginArchiveImportSchema } from '@/lib/projects/archive-import'
import { ownedArchiveImport } from '@/lib/server/archive-import'
import { consumeQuota } from '@/lib/server/rate-limit'

export async function POST(request: Request) {
  const requestId = crypto.randomUUID()
  try {
    const auth = await requireUser(request)
    assertSameOrigin(request)
    const { id, ...input } = await parseBody(request, beginArchiveImportSchema)
    const quota = await consumeQuota(auth.user.id, 'import-create')
    return apiJson(await ownedArchiveImport(auth, id, 'begin', input, request.signal), requestId, 201, quota)
  } catch (error) { return apiFailure(error, requestId) }
}
