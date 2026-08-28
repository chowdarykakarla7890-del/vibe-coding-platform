import 'server-only'
import type { Command } from '@vercel/sandbox'
import { truncateUtf8, utf8ByteLength } from '@/lib/text-limits'
import { abortableRead } from '@/lib/abortable-read'
import { readCommandLogs, type CommandOutputEncoding } from './command-output'

export const COMMAND_TIMEOUT_MS = 60_000
export const COMMAND_OUTPUT_BYTES = 64 * 1024

/** Capture an already reserved command. The owner handles process cleanup. */
export async function captureCommandOutput(command: Command, callerSignal?: AbortSignal, encoding: CommandOutputEncoding = 'raw') {
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(new DOMException('Command timed out after 60 seconds.', 'TimeoutError')), COMMAND_TIMEOUT_MS)
  const signal = AbortSignal.any([deadline.signal, ...(callerSignal ? [callerSignal] : [])])
  let logs: ReturnType<typeof readCommandLogs> | undefined
  try {
    signal.throwIfAborted()
    logs = readCommandLogs(command, encoding, signal)
    const collectOutput = async () => {
      let output = ''
      let bytes = 0
      while (true) {
        const next = await abortableRead(() => logs!.next(), signal)
        if (next.done) break
        const log = next.value
        signal.throwIfAborted()
        const chunk = truncateUtf8(log.data, COMMAND_OUTPUT_BYTES - bytes)
        output += chunk
        bytes += utf8ByteLength(chunk)
        if (chunk.length < log.data.length || bytes >= COMMAND_OUTPUT_BYTES) {
          logs!.close()
          return { output, outputTruncated: true }
        }
      }
      return { output, outputTruncated: false }
    }
    const [finished, captured] = await Promise.all([abortableRead(() => command.wait({ signal }), signal), collectOutput()])
    signal.throwIfAborted()
    return { exitCode: finished.exitCode, ...captured }
  } catch (error) {
    // Abort the sibling read/wait even if only one of them failed.
    deadline.abort()
    logs?.close()
    throw error
  } finally {
    clearTimeout(timer)
    logs?.close()
  }
}
