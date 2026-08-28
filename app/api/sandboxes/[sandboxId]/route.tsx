import { apiFailure, apiJson, assertSameOrigin, requireOwnedSandboxRecord, requireUser } from '@/lib/server/api'
import { getOwnedSandbox, stopOwnedSandbox } from '@/lib/server/sandbox'
import { readOwnedShutdown } from '@/lib/server/sandbox-shutdown'

export const maxDuration = 60

type Context = { params: Promise<{ sandboxId: string }> }

export async function GET(request: Request, { params }: Context) {
  const requestId = crypto.randomUUID()
  try {
    const { sandboxId } = await params
    const auth = await requireUser(request)
    const session = await requireOwnedSandboxRecord(sandboxId, auth, request.signal)
    const shutdown = await readOwnedShutdown(auth, session)
    if (shutdown) return apiJson(shutdown, requestId)
    await getOwnedSandbox(auth, sandboxId, undefined, request.signal)
    return apiJson({ status: 'running' }, requestId)
  } catch (error) { return apiFailure(error, requestId) }
}

export async function DELETE(request: Request, { params }: Context) {
  const requestId = crypto.randomUUID()
  try {
    const auth = await requireUser(request)
    assertSameOrigin(request)
    const { sandboxId } = await params
    const result = await stopOwnedSandbox(auth, sandboxId)
    return apiJson(result, requestId, result.stopped ? 200 : 202, result.stopped ? undefined : { 'Retry-After': '3' })
  } catch (error) { return apiFailure(error, requestId) }
}
