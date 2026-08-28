import 'server-only'
import type { Command } from '@vercel/sandbox'
import { abortableRead } from '@/lib/abortable-read'

/** Detached commands can retain a null exit code until the wait endpoint is
 * consulted. Probe it briefly; never wait for a background process's lifetime. */
export async function readCommandExitCode(command: Command, signal: AbortSignal) {
  signal.throwIfAborted()
  if (command.exitCode !== null) return command.exitCode
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(new DOMException('Command still running.', 'TimeoutError')), 1_000)
  const probeSignal = AbortSignal.any([signal, deadline.signal])
  try {
    return (await abortableRead(() => command.wait({ signal: probeSignal }), probeSignal)).exitCode
  } catch (error) {
    signal.throwIfAborted()
    if (deadline.signal.aborted) return null
    throw error
  } finally {
    clearTimeout(timer)
    deadline.abort()
  }
}
