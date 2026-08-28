/** Error reporting must never throw while a recovery boundary is rendering. */
export function errorDiagnostics(error: unknown): { errorName: string; digest?: string } {
  try {
    if (!(error instanceof Error)) return { errorName: 'UnknownError' }
    const name = error.name
    const digest: unknown = 'digest' in error ? error.digest : undefined
    return {
      errorName: typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? name : 'Error',
      ...(typeof digest === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(digest) ? { digest } : {}),
    }
  } catch {
    // Even metadata access can fail (for example a custom Error getter).
    // Never serialize the thrown value, message, stack or provider response.
    return { errorName: 'UnknownError' }
  }
}
