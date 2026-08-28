export function abortableDelay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve() }, ms)
    function cancel() { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(signal.reason) }
    signal.addEventListener('abort', cancel, { once: true })
  })
}
