import { ApiError, apiFailure } from '@/lib/server/api'
import { commandForRequest } from '@/lib/server/owned-command'
import { isSandboxUnavailableError } from '@/ai/sandbox'
import { abortableRead } from '@/lib/abortable-read'
import { commandLogStream } from '@/lib/server/command-logs'
import { COMMAND_LOG_WINDOW_MS, commandIdSchema, logCursorSchema, INITIAL_LOG_CURSOR } from '@/lib/commands/protocol'

// Log responses still close at 20 seconds; after() captures source separately.
export const maxDuration = 90

export async function GET(request: Request, { params }: { params: Promise<{ sandboxId: string; cmdId: string }> }) {
  const requestId = crypto.randomUUID()
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(new DOMException('Log window ended.', 'TimeoutError')), COMMAND_LOG_WINDOW_MS)
  const signal = AbortSignal.any([request.signal, deadline.signal])
  const dispose = () => clearTimeout(timer)
  try {
    const { sandboxId, cmdId } = await params
    if (!commandIdSchema.safeParse(cmdId).success) throw new ApiError(400, 'INVALID_COMMAND_ID', 'Choose a valid command.')
    const value = new URL(request.url).searchParams.get('cursor') ?? INITIAL_LOG_CURSOR
    const cursor = logCursorSchema.safeParse(value === '-1' ? INITIAL_LOG_CURSOR : value)
    if (!cursor?.success) throw new ApiError(400, 'INVALID_CURSOR', 'The command log cursor is invalid.')
    const { command, complete, encoding } = await abortableRead(() => commandForRequest(request, sandboxId, cmdId, signal), signal)
    return new Response(commandLogStream({ command, complete, encoding, cursor: cursor.data, requestId, signal, deadline: deadline.signal, dispose }), {
      headers: { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/x-ndjson', 'X-Request-Id': requestId, 'X-Log-Cursor-Version': '3' },
    })
  } catch (error) {
    dispose()
    if (error instanceof ApiError) return apiFailure(error, requestId)
    if (isSandboxUnavailableError(error)) return apiFailure(new ApiError(410, 'COMMAND_EXPIRED', 'This command output is no longer available. Run the command again.'), requestId)
    if (signal.aborted) return apiFailure(new ApiError(408, 'COMMAND_READ_INTERRUPTED', 'The command connection timed out or was cancelled. Retry to reconnect.'), requestId)
    return apiFailure(error, requestId)
  }
}
