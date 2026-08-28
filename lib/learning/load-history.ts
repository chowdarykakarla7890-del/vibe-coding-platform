import { listProgress, listProjects } from './db'
import { readWithDeadline } from '@/lib/abortable-read'

export const HISTORY_LOAD_TIMEOUT_MS = 10_000

/** A blocked browser database must not leave startup waiting indefinitely. */
export async function loadWorkspaceHistory(signal: AbortSignal) {
  signal.throwIfAborted()
  const controller = new AbortController()
  try {
    return await readWithDeadline(
      (readSignal) => Promise.all([listProjects(readSignal), listProgress(readSignal)]),
      AbortSignal.any([signal, controller.signal]),
      HISTORY_LOAD_TIMEOUT_MS,
      'Opening saved history timed out.',
    )
  } finally {
    // A rejected project read must cancel its still-pending progress sibling
    // (and vice versa), without cancelling the user's other operations.
    controller.abort()
  }
}
