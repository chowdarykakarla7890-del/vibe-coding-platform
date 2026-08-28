import { ApiError, apiFailure, apiJson, assertSameOrigin, parseBody, requireUser } from '@/lib/server/api'
import { connectOwnedSandboxPreview, readOwnedSandboxPreview } from '@/lib/server/sandbox'
import { previewRequestSchema } from '@/lib/sandbox/preview'
import { consumeQuota } from '@/lib/server/rate-limit'
import { readWithDeadline } from '@/lib/abortable-read'
import { awaitMutationReceipt } from '@/lib/mutation-receipt'

export const maxDuration = 40
type Context = { params: Promise<{ sandboxId: string }> }

async function handle(request: Request, context: Context, save: boolean) {
  const requestId = crypto.randomUUID()
  try {
    return await (save ? awaitMutationReceipt : readWithDeadline)(async signal => {
      const auth = await requireUser(request)
      signal.throwIfAborted()
      const { sandboxId } = await context.params
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sandboxId)) throw new ApiError(400, 'INVALID_SANDBOX_ID', 'Choose a valid sandbox.')
      if (save) assertSameOrigin(request)
      let input
      if (save) input = await parseBody(request, previewRequestSchema, 1024)
      else {
        const query = new URL(request.url).searchParams
        const entries = [...query]
        if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new ApiError(400, 'INVALID_REQUEST', 'Send one value per preview field.')
        const parsed = previewRequestSchema.safeParse(Object.fromEntries(entries.map(([key, value]) => [key, key === 'port' && /^\d+$/.test(value) ? Number(value) : value])))
        if (!parsed.success) throw new ApiError(400, 'INVALID_REQUEST', 'Choose a valid project and exposed port.')
        input = parsed.data
      }
      signal.throwIfAborted()
      const headers = await consumeQuota(auth.user.id, 'sandbox-preview')
      signal.throwIfAborted()
      const preview = await (save ? connectOwnedSandboxPreview : readOwnedSandboxPreview)(auth, sandboxId, input.projectId, input.port, signal)
      signal.throwIfAborted()
      return apiJson({ ...preview, requestId }, requestId, 200, headers)
    }, request.signal, 30_000, 'Preview connection timed out. Reconnect to check its current state.')
  } catch (error) {
    if (request.signal.aborted || (error instanceof Error && /timed out|could not be confirmed/.test(error.message))) {
      return apiFailure(new ApiError(408, 'PREVIEW_INTERRUPTED', 'The preview connection was interrupted. Reconnect to check its current state.'), requestId)
    }
    return apiFailure(error, requestId)
  }
}

export const GET = (request: Request, context: Context) => handle(request, context, false)
export const POST = (request: Request, context: Context) => handle(request, context, true)
