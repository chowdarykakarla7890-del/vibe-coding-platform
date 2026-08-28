import { CommandOutputError, streamCommandLogs, type CommandStreamRecord } from '@/components/commands-logs/api'
import { advancingLogCursor, INITIAL_LOG_CURSOR } from './protocol'

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return }
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}
function retryable(error: unknown) {
  return error instanceof CommandOutputError
    ? error.code !== 'INVALID_COMMAND_STREAM' && (error.status >= 500 || error.status === 408 || error.status === 429)
    : error instanceof TypeError || (error instanceof Error && error.name === 'TimeoutError')
}

/** One owner invokes this per command; checkpoints survive component remounts. */
export async function followCommandLogs(options: {
  sandboxId: string; cmdId: string; cursor?: string; signal: AbortSignal
  onRecord: (record: CommandStreamRecord) => void
}) {
  const { sandboxId, cmdId, signal, onRecord } = options
  let cursor = options.cursor ?? INITIAL_LOG_CURSOR
  let failures = 0
  while (!signal.aborted) {
    try {
      for await (const record of streamCommandLogs(sandboxId, cmdId, cursor, signal)) {
        if (signal.aborted) return
        if (record.type === 'log') {
          if (!advancingLogCursor(record.cursor, cursor)) continue
          cursor = record.cursor
        }
        onRecord(record)
        if (record.type === 'status' && record.status !== 'running') return
      }
      failures = 0
      await delay(500, signal)
    } catch (error) {
      if (signal.aborted) return
      if (!retryable(error) || failures >= 3) throw error
      const retryAfter = error instanceof CommandOutputError ? error.retryAfterMs : 0
      await delay(Math.max(retryAfter, 500 * 2 ** failures++), signal)
    }
  }
}
