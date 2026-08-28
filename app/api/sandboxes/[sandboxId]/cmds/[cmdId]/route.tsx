import { ApiError, apiFailure, apiJson, assertSameOrigin } from '@/lib/server/api'
import { commandForRequest } from '@/lib/server/owned-command'
import { isSandboxUnavailableError } from '@/ai/sandbox'
import { abortableRead } from '@/lib/abortable-read'
import { commandIdSchema } from '@/lib/commands/protocol'
import { readCommandExitCode } from '@/lib/server/command-status'

export const maxDuration = 90

export async function GET(request: Request, { params }: { params: Promise<{ sandboxId: string; cmdId: string }> }) {
  const requestId = crypto.randomUUID()
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)])
  try {
    const { sandboxId, cmdId } = await params
    if (!commandIdSchema.safeParse(cmdId).success) throw new ApiError(400, 'INVALID_COMMAND_ID', 'Choose a valid command.')
    const { command, complete } = await abortableRead(() => commandForRequest(request, sandboxId, cmdId, signal), signal)
    const exitCode = await readCommandExitCode(command, signal)
    if (exitCode !== null) await complete(exitCode, signal)
    return apiJson({ sandboxId, cmdId: command.cmdId, startedAt: command.startedAt, status: exitCode === null ? 'running' : 'done', exitCode }, requestId)
  } catch (error) {
    if (error instanceof ApiError) return apiFailure(error, requestId)
    if (isSandboxUnavailableError(error)) return apiFailure(new ApiError(410, 'COMMAND_EXPIRED', 'This command output is no longer available. Run the command again.'), requestId)
    if (signal.aborted) return apiFailure(new ApiError(408, 'COMMAND_READ_INTERRUPTED', 'The command connection timed out or was cancelled. Retry to reconnect.'), requestId)
    return apiFailure(error, requestId)
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ sandboxId: string; cmdId: string }> }) {
  const requestId = crypto.randomUUID()
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)])
  try {
    assertSameOrigin(request)
    const { sandboxId, cmdId } = await params
    if (!commandIdSchema.safeParse(cmdId).success) throw new ApiError(400, 'INVALID_COMMAND_ID', 'Choose a valid command.')
    const execution = await abortableRead(() => commandForRequest(request, sandboxId, cmdId, signal), signal)
    const exitCode = await readCommandExitCode(execution.command, signal)
    if (exitCode !== null) await execution.complete(exitCode, signal)
    else await execution.cancel()
    return apiJson({ stopped: true }, requestId)
  } catch (error) {
    if (signal.aborted && !(error instanceof ApiError)) return apiFailure(new ApiError(408, 'COMMAND_STOP_INTERRUPTED', 'The stop request was interrupted. Check the command status before retrying.'), requestId)
    return apiFailure(error, requestId)
  }
}
