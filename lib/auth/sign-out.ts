'use client'

import { z } from 'zod'
import { cloudOperation } from '@/lib/learning/cloud-request'
import { awaitMutationReceipt } from '@/lib/mutation-receipt'

export const SIGN_OUT_TIMEOUT_MS = 20_000
export const SIGN_OUT_UNCONFIRMED = 'Sign-out could not be confirmed. It may already have completed. Your saved work has not been cleared; retry when your connection is available.'
export class SignOutAccountChangedError extends Error {
  override name = 'SignOutAccountChangedError'
  constructor() { super('The signed-in account changed. Save or copy unsaved changes, then reload the workspace before trying again.') }
}
const receipt = z.object({ signedOut: z.literal(true) }).strict()

/** Confirm one account-scoped request; never retry or navigate from inside it. */
export async function signOutWorkspace(userId: string, signal: AbortSignal) {
  const operation = cloudOperation(signal)
  if (operation.userId !== userId) throw new SignOutAccountChangedError()
  await awaitMutationReceipt(async requestSignal => {
    const response = await operation.fetch('/auth/sign-out', {
      method: 'POST', headers: { accept: 'application/json' },
      signal: requestSignal, cache: 'no-store', redirect: 'error',
    })
    requestSignal.throwIfAborted()
    if (response.status === 409) throw new SignOutAccountChangedError()
    if (!response.ok) throw new Error(SIGN_OUT_UNCONFIRMED)
    const payload: unknown = await response.json().catch(() => undefined)
    requestSignal.throwIfAborted()
    operation.assertActive()
    if (!receipt.safeParse(payload).success) throw new Error(SIGN_OUT_UNCONFIRMED)
  }, operation.signal, SIGN_OUT_TIMEOUT_MS, SIGN_OUT_UNCONFIRMED)
  operation.assertActive()
}

export function openSignInAfterSignOut() {
  // Hard navigation releases this account's in-memory workspace and requests.
  // No project, browser storage or draft is deleted by the sign-out controls.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- Release all account-scoped client state after logout.
  window.location.assign('/sign-in')
}
