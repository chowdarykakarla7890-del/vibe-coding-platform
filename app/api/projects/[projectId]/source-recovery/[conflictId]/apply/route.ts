import { apiFailure, apiJson, assertSameOrigin, parseBody, requireUser } from '@/lib/server/api'
import { consumeQuota } from '@/lib/server/rate-limit'
import { applyOwnedSourceResolution } from '@/lib/server/source-resolution-apply'
import { applyResolutionRequestSchema } from '@/lib/source-recovery'

export const maxDuration = 60
type Context = { params: Promise<{ projectId: string; conflictId: string }> }
export async function POST(request: Request, context: Context) {
  const requestId = crypto.randomUUID()
  try {
    const auth = await requireUser(request)
    assertSameOrigin(request)
    const { projectId, conflictId } = await context.params
    const input = await parseBody(request, applyResolutionRequestSchema, 1024)
    const quota = await consumeQuota(auth.user.id, 'sandbox-mutation')
    const receipt = await applyOwnedSourceResolution(auth, projectId, conflictId, input)
    return apiJson(receipt, requestId, 200, quota)
  } catch (error) { return apiFailure(error, requestId) }
}
