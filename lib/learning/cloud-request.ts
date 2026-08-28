'use client'

import { z } from 'zod'
import { getApiErrorMessage } from '@/lib/api-error'
import { readWithDeadline } from '@/lib/abortable-read'
import { awaitMutationReceipt } from '@/lib/mutation-receipt'

let account: { userId: string; controller: AbortController } | undefined

export function setCloudAccount(userId: string | undefined) {
  if (userId === account?.userId) return
  if (userId) z.string().uuid().parse(userId)
  account?.controller.abort()
  account = userId ? { userId, controller: new AbortController() } : undefined
}

/** Capture once per operation so late work cannot use another account's cookies. */
export function cloudOperation(callerSignal?: AbortSignal) {
  const originAccount = account
  if (!originAccount) throw new Error('Sign in before opening account data.')
  const signal = callerSignal
    ? AbortSignal.any([originAccount.controller.signal, callerSignal])
    : originAccount.controller.signal
  function assertActive() {
    signal.throwIfAborted()
    if (account !== originAccount) throw new Error('The signed-in account changed. Please retry.')
  }
  return {
    userId: originAccount.userId,
    assertActive,
    signal,
    async fetch(path: string | URL | Request, init?: RequestInit) {
      assertActive()
      const headers = new Headers(init?.headers)
      headers.set('X-CodeTutor-Account', originAccount.userId)
      const response = await fetch(path, { ...init, credentials: 'same-origin', headers,
        signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
      })
      assertActive()
      return response
    },
    async request<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, method = 'GET', body?: unknown) {
      assertActive()
      const request = async (requestSignal: AbortSignal) => {
        const response = await fetch(path, {
          method, credentials: 'same-origin', cache: 'no-store',
          signal: requestSignal,
          headers: { 'X-CodeTutor-Account': originAccount.userId, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        requestSignal.throwIfAborted()
        const payload: unknown = await response.json().catch(() => undefined)
        requestSignal.throwIfAborted()
        assertActive()
        if (!response.ok) throw new Error(getApiErrorMessage(payload, 'Cloud storage is unavailable. Your saved work has not been cleared.'))
        const result = schema.safeParse(payload)
        if (!result.success) throw new Error('Cloud storage returned an invalid response. Please retry.')
        return result.data
      }
      // A signal alone cannot settle a body reader that ignores cancellation.
      // Bound the complete receipt before callers cache or publish its result.
      // An unacknowledged write must never be retried or rolled back here.
      return method.toUpperCase() === 'GET'
        ? readWithDeadline(request, signal, 20_000, 'Loading saved work timed out. Your saved work has not been cleared. Please retry.')
        : awaitMutationReceipt(request, signal, 20_000, 'The save confirmation timed out. The change may still finish. Reopen the project to check its saved state before retrying.')
    },
  }
}
