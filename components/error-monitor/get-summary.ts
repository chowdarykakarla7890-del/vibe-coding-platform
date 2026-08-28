import { resultSchema, type Line, type Lines } from './schemas'
import { getApiErrorMessage } from '@/lib/api-error'
import { cloudOperation } from '@/lib/learning/cloud-request'
import { awaitMutationReceipt } from '@/lib/mutation-receipt'

export async function getSummary(
  sandboxId: string,
  lines: Line[],
  previous: Line[],
  signal?: AbortSignal
) {
  const operation = cloudOperation(signal)
  const payload: Lines = { sandboxId, lines: lines.slice(-4), previous: previous.slice(-4) }
  // Bound UTF-8 JSON overhead, not only string lengths. Keep the newest
  // failures; older context is optional and never justifies an oversized call.
  const bytes = () => new TextEncoder().encode(JSON.stringify(payload)).byteLength
  while (payload.previous.length && bytes() > 96 * 1024) payload.previous.shift()
  while (payload.lines.length > 1 && bytes() > 96 * 1024) payload.lines.shift()
  if (bytes() > 96 * 1024) throw new Error('This diagnostic report is too large. Use Help debug with a smaller excerpt.')
  return awaitMutationReceipt(async requestSignal => {
    const response = await operation.fetch('/api/errors', {
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      signal: requestSignal,
    })
    const body: unknown = await response.json().catch(() => undefined)
    operation.assertActive()
    requestSignal.throwIfAborted()
    if (!response.ok) {
      throw new Error(
        getApiErrorMessage(body, 'The command errors could not be analyzed.')
      )
    }
    const result = resultSchema.safeParse(body)
    if (!result.success || (result.data.shouldBeFixed && !result.data.summary.trim())) throw new Error('The error analysis returned an invalid response. Please retry.')
    return result.data
  }, operation.signal, 50_000, 'Error analysis timed out. No automatic retry was started; a provider request may still have incurred usage.')
}
