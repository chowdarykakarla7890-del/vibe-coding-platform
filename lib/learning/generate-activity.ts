'use client'

import { getApiErrorMessage } from '@/lib/api-error'
import { awaitMutationReceipt } from '@/lib/mutation-receipt'
import { cloudOperation } from './cloud-request'
import { activityManifestSchema } from './types'
import { ACTIVITY_RECEIPT_TIMEOUT_MS, activityGenerationRequestSchema, type ActivityGenerationRequest } from './activity-generation'

/** One paid mutation, never automatically retried; a lost receipt is ambiguous. */
export async function generateActivity(input: ActivityGenerationRequest, callerSignal: AbortSignal) {
  const payload = activityGenerationRequestSchema.parse(input)
  const origin = cloudOperation(callerSignal)
  const activity = await awaitMutationReceipt(async signal => {
    const response = await origin.fetch('/api/activities/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal,
    })
    signal.throwIfAborted()
    const body: unknown = await response.json().catch(() => undefined)
    signal.throwIfAborted()
    origin.assertActive()
    if (!response.ok) throw new Error(getApiErrorMessage(body, 'Activity generation could not be completed.'))
    const parsed = activityManifestSchema.safeParse(
      body && typeof body === 'object' ? (body as { activity?: unknown }).activity : undefined
    )
    if (!parsed.success || parsed.data.source !== 'generated' ||
        !parsed.data.id.startsWith(`generated-${payload.mode}-`) || parsed.data.mode !== payload.mode) {
      throw new Error('The generated activity response was invalid.')
    }
    return parsed.data
  }, origin.signal, ACTIVITY_RECEIPT_TIMEOUT_MS,
  'Generation confirmation timed out. It may still finish. Reload saved activities before generating again.')
  origin.assertActive()
  return activity
}
