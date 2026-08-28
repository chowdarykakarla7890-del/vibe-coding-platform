/** A missing receipt does not prove that a server-side write was rolled back. */
export class MutationReceiptTimeoutError extends Error {
  override name = 'MutationReceiptTimeoutError'
}

/**
 * Bound the wait for one mutation's headers AND body, including transports
 * that ignore cancellation. Never retry or undo the mutation here. Callers
 * must keep drafts and reconcile an unknown outcome before another save.
 * `request` must only dispatch/read/validate; publish UI changes after await,
 * so a receipt arriving after timeout or unmount cannot acknowledge old work.
 */
export async function awaitMutationReceipt<T>(
  request: (signal: AbortSignal) => Promise<T>,
  callerSignal: AbortSignal,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  callerSignal.throwIfAborted()
  const deadline = new AbortController()
  const signal = AbortSignal.any([callerSignal, deadline.signal])
  const timer = setTimeout(() => deadline.abort(new MutationReceiptTimeoutError(timeoutMessage)), timeoutMs)
  let onAbort: (() => void) | undefined
  try {
    return await new Promise<T>((resolve, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
      // Observe both outcomes even after cancellation; no late rejection is
      // unhandled and no late success is published by the waiting component.
      void Promise.resolve().then(() => {
        signal.throwIfAborted()
        return request(signal)
      }).then(value => {
        if (signal.aborted) reject(signal.reason)
        else resolve(value)
      }, reject)
    })
  } finally {
    clearTimeout(timer)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}
