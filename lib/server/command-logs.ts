import 'server-only'
import type { Command } from '@vercel/sandbox'
import { ApiError } from './api'
import { isSandboxUnavailableError } from '@/ai/sandbox'
import { abortableRead } from '@/lib/abortable-read'
import { COMMAND_LOG_WINDOW_BYTES, parseLogCursor, type CommandStreamRecord } from '@/lib/commands/protocol'
import { readCommandExitCode } from './command-status'
import { readCommandLogs, type CommandOutputEncoding } from './command-output'

/** A bounded, replayable view over SDK logs. */
export function commandLogStream(options: {
  command: Command
  encoding?: CommandOutputEncoding
  complete: (exitCode: number, signal: AbortSignal) => Promise<void>
  cursor: string
  requestId: string
  signal: AbortSignal
  deadline: AbortSignal
  dispose: () => void
}) {
  const { command, encoding = 'raw', complete, cursor: requestedCursor, requestId, signal, deadline, dispose } = options
  const cancellation = new AbortController()
  const readSignal = AbortSignal.any([signal, cancellation.signal])
  let logs: ReturnType<typeof readCommandLogs> | undefined
  let cancelled = false
  const encoder = new TextEncoder()

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const streamOffsets = { stdout: 0, stderr: 0 }
      const consumed = parseLogCursor(requestedCursor)!
      let bytesSent = 0
      let logsComplete = false
      const emit = (record: CommandStreamRecord) => controller.enqueue(encoder.encode(`${JSON.stringify(record)}\n`))
      try {
        readSignal.throwIfAborted()
        logs = readCommandLogs(command, encoding, readSignal)
        streamLoop: while (true) {
          const result = await abortableRead(() => logs!.next(), readSignal)
          if (result.done) { logsComplete = true; break }
          const data = Buffer.from(result.value.data, 'utf8')
          const source = result.value.stream
          const streamOffset = streamOffsets[source]
          const endOffset = streamOffset + data.byteLength
          if (endOffset > consumed[source]) {
            let start = Math.max(0, consumed[source] - streamOffset)
            if ((data[start] & 0xc0) === 0x80) throw new ApiError(400, 'INVALID_CURSOR', 'The cursor splits a UTF-8 character. Reload this command output.')
            while (start < data.byteLength) {
              readSignal.throwIfAborted()
              let end = Math.min(start + 8192, data.byteLength)
              while (end < data.byteLength && (data[end] & 0xc0) === 0x80) end--
              const next = { ...consumed, [source]: streamOffset + end }
              const record = encoder.encode(`${JSON.stringify({ type: 'log', cursor: `v3.${next.stdout}.${next.stderr}`, stream: source, data: data.toString('utf8', start, end), timestamp: command.startedAt })}\n`)
              // Never acknowledge an omitted suffix. The next request replays
              // from the last byte actually delivered, even if chunks regroup.
              if (bytesSent + record.byteLength > COMMAND_LOG_WINDOW_BYTES - 1024) break streamLoop
              bytesSent += record.byteLength
              controller.enqueue(record)
              consumed[source] = next[source]
              start = end
            }
          }
          streamOffsets[source] = endOffset
        }
        const exitCode = logsComplete ? await readCommandExitCode(command, readSignal) : null
        if (exitCode !== null) await complete(exitCode, readSignal)
        if (!cancelled && !readSignal.aborted) emit({ type: 'status', status: logsComplete && exitCode !== null ? 'done' : 'running', exitCode: logsComplete ? exitCode : null })
      } catch (error) {
        if (!cancelled) {
          if (deadline.aborted) emit({ type: 'status', status: 'running', exitCode: null })
          else if (!readSignal.aborted && isSandboxUnavailableError(error)) emit({ type: 'status', status: 'expired', exitCode: null })
          else if (!readSignal.aborted) {
            const expected = error instanceof ApiError
            if (!expected) console.error('Command log stream failed', { requestId, errorName: error instanceof Error ? error.name : 'UnknownError' })
            emit({ type: 'error', status: expected ? error.status : 502, error: {
              code: expected ? error.code : 'COMMAND_LOGS_FAILED', message: expected ? error.message : 'The command output connection was interrupted. Retry to reconnect.', requestId,
            } })
          }
        }
      } finally {
        cancellation.abort()
        // SDK close() aborts a pending next(). Awaiting generator.return()
        // before aborting would itself hang on an idle background server.
        logs?.close()
        dispose()
        if (!cancelled) controller.close()
      }
    },
    cancel() { cancelled = true; cancellation.abort(); logs?.close(); dispose() },
  })
}
