/** Cancel waiting for a read, even when its storage driver cannot be aborted.
 * The underlying promise is still observed, so late failures are handled.
 * Do not use this for writes: a cancelled wait does not roll back a write.
 */
export function abortableRead<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve().then(() => {
      signal.throwIfAborted()
      return read()
    }).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

export async function readWithDeadline<T>(read: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, timeoutMs: number, message: string) {
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(new Error(message)), timeoutMs)
  const readSignal = AbortSignal.any([signal, deadline.signal])
  try {
    // Pass the deadline through to network-backed readers too. Stopping only
    // the wait would leave obsolete pagination running behind a Retry screen.
    return await abortableRead(() => read(readSignal), readSignal)
  } finally {
    clearTimeout(timer)
  }
}
