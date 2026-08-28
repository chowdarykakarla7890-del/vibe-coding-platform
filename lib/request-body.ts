import { abortableRead } from './abortable-read'

export const REQUEST_BODY_TIMEOUT_MS = 10_000
export type JsonBodyResult =
  | { ok: true; data: unknown }
  | { ok: false; reason: 'invalid' | 'too-large' | 'unsupported-content-type' | 'aborted' | 'timeout' }

export async function readJsonBody(
  request: Request,
  maxBytes: number
): Promise<JsonBodyResult> {
  const rejectUnread = (reason: Extract<JsonBodyResult, { ok: false }>['reason']): JsonBodyResult => {
    // Cancelling an adversarial/failed transport can itself hang. Observe it,
    // but do not wait for it or take a reader owned by another operation.
    if (request.body && !request.body.locked) void request.body.cancel().catch(() => undefined)
    return { ok: false, reason }
  }
  if (request.signal.aborted) return rejectUnread('aborted')
  if (
    !request.headers
      .get('content-type')
      ?.split(';', 1)[0].trim().toLowerCase()
      .match(/^application\/json$/)
  ) {
    return rejectUnread('unsupported-content-type')
  }

  const declaredLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return rejectUnread('too-large')
  }
  if (!request.body || request.bodyUsed || request.body.locked) return { ok: false, reason: 'invalid' }

  const reader = request.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), REQUEST_BODY_TIMEOUT_MS)
  const signal = AbortSignal.any([request.signal, deadline.signal])
  let complete = false
  let totalBytes = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await abortableRead(() => reader.read(), signal)
      signal.throwIfAborted()
      if (done) { complete = true; break }
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        return { ok: false, reason: 'too-large' }
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    return { ok: true, data: JSON.parse(text) }
  } catch {
    return { ok: false, reason: request.signal.aborted ? 'aborted' : deadline.signal.aborted ? 'timeout' : 'invalid' }
  } finally {
    clearTimeout(timer)
    if (!complete) void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
