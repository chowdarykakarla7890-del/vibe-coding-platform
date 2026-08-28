import { isAuthError, isAuthSessionMissingError, type SupabaseClient, type User } from '@supabase/supabase-js'
import { awaitMutationReceipt } from '@/lib/mutation-receipt'

export const AUTH_CHECK_TIMEOUT_MS = 10_000
export const AUTH_UNAVAILABLE_MESSAGE = 'The sign-in service is temporarily unavailable. Your saved work has not been cleared. Please try again.'

export class AuthUnavailableError extends Error {
  override name = 'AuthUnavailableError'
  constructor() { super(AUTH_UNAVAILABLE_MESSAGE) }
}

export class AuthRequestInterruptedError extends Error {
  override name = 'AuthRequestInterruptedError'
  constructor() { super('The authentication request was interrupted. Please retry.') }
}

const SIGNED_OUT_CODES = new Set([
  'bad_jwt', 'invalid_jwt', 'no_authorization', 'user_not_found',
  'session_not_found', 'session_expired', 'refresh_token_not_found',
  'refresh_token_already_used', 'user_banned',
])

function isSignedOutError(error: unknown) {
  if (!isAuthError(error) || error.status === 429 || (error.status ?? 0) >= 500) return false
  return isAuthSessionMissingError(error) || (error.code !== undefined && SIGNED_OUT_CODES.has(error.code))
}

/** Auth checks may refresh tokens. A timeout is not a rollback of that refresh. */
export async function withAuthDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, callerSignal?: AbortSignal): Promise<T> {
  const lifecycle = new AbortController()
  const signal = callerSignal ? AbortSignal.any([callerSignal, lifecycle.signal]) : lifecycle.signal
  try {
    return await awaitMutationReceipt(operation, signal, AUTH_CHECK_TIMEOUT_MS, AUTH_UNAVAILABLE_MESSAGE)
  } catch {
    lifecycle.abort()
    if (callerSignal?.aborted) throw new AuthRequestInterruptedError()
    // Never expose provider bodies, token strings, or network/config details.
    throw new AuthUnavailableError()
  }
}

/** Bind cancellation to SDK fetches, including later refresh retries. */
export function authFetch(signal: AbortSignal, fetcher: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const combined = requestSignal ? AbortSignal.any([signal, requestSignal]) : signal
    combined.throwIfAborted()
    return fetcher(input, { ...init, signal: combined })
  }
}

type AuthClient = Pick<SupabaseClient, 'auth'>

/** The live Auth server, not decoded/cached claims, authorizes workspace data. */
export async function verifiedUser(client: AuthClient): Promise<User | null> {
  try {
    const result = await client.auth.getUser()
    if (result.error) throw result.error
    const user = result.data?.user
    if (user === null || user?.is_anonymous === true) return null
    if (!user || typeof user.id !== 'string' || !user.id.trim()) throw new AuthUnavailableError()
    return user
  } catch (error) {
    if (isSignedOutError(error)) return null
    throw new AuthUnavailableError()
  }
}

/** Optimistic routing only; the layout and API still use verifiedUser. */
export async function hasVerifiedClaims(client: AuthClient): Promise<boolean> {
  try {
    const result = await client.auth.getClaims()
    if (result.error) throw result.error
    if (result.data === null) return false
    const claims = result.data?.claims
    if (!claims || typeof claims.sub !== 'string' || !claims.sub.trim()) throw new AuthUnavailableError()
    return claims.is_anonymous !== true
  } catch (error) {
    if (isSignedOutError(error)) return false
    throw new AuthUnavailableError()
  }
}
