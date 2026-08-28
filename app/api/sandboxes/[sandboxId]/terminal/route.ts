import { ApiError, apiFailure, apiJson, assertSameOrigin, parseBody, requireUser } from '@/lib/server/api'
import { startOwnedCommand } from '@/lib/server/owned-command'
import { isSandboxUnavailableError } from '@/ai/sandbox'
import { z } from 'zod'

const commandSchema = z.object({
  command: z.string().trim().min(1).max(2000).refine((value) => !value.includes('\0')),
  background: z.boolean().default(false),
}).strict()

// The HTTP response is immediate; after() has a separate bounded capture job.
export const maxDuration = 90

export async function POST(request: Request, { params }: { params: Promise<{ sandboxId: string }> }) {
  const requestId = crypto.randomUUID()
  try {
    const auth = await requireUser(request)
    assertSameOrigin(request)
    const body = await parseBody(request, commandSchema, 8192)
    const { sandboxId } = await params
    const execution = await startOwnedCommand(auth, sandboxId, {
      executable: 'sh', args: ['-lc', body.command], background: body.background,
    }, { origin: 'terminal', requestId, signal: request.signal })
    return apiJson({ cmdId: execution.command.cmdId, sandboxId, background: body.background, requestId }, requestId, 200, execution.headers)
  } catch (error) {
    if (error instanceof ApiError) return apiFailure(error, requestId)
    if (isSandboxUnavailableError(error)) return apiFailure(new ApiError(410, 'SANDBOX_EXPIRED', 'This sandbox expired. Restore your project to continue.'), requestId)
    if (request.signal.aborted || (error instanceof Error && ['AbortError','TimeoutError'].includes(error.name))) {
      return apiFailure(new ApiError(408, 'COMMAND_START_INTERRUPTED', 'Command start was interrupted. Check the terminal before retrying.'), requestId)
    }
    return apiFailure(error, requestId)
  }
}
