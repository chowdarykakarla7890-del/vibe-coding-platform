import { afterEach, expect, it, vi } from 'vitest'
import { readJsonBody } from '@/lib/request-body'

afterEach(() => vi.useRealTimers())
const request = (body: string | ReadableStream<Uint8Array>, init: RequestInit = {}) => new Request('http://localhost/api/test', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half', ...init,
} as RequestInit)

it('settles a stalled request body within ten seconds and cancels its reader', async () => {
  vi.useFakeTimers()
  const cancel = vi.fn()
  let streamController!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({ start(controller) { streamController = controller }, cancel })
  let result: unknown
  const reading = readJsonBody(request(stream), 100).then(value => { result = value })
  try {
    await vi.advanceTimersByTimeAsync(10_001)
    expect(result).toEqual({ ok: false, reason: 'timeout' })
    expect(cancel).toHaveBeenCalledOnce()
  } finally {
    try { streamController.close() } catch { /* already cancelled */ }
    await reading
  }
})
it('settles cancellation while waiting for a chunk and releases the stream lock', async () => {
  const controller = new AbortController(), cancel = vi.fn()
  let streamController!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({ start(value) { streamController = value }, cancel })
  let result: unknown
  const reading = readJsonBody(request(stream, { signal: controller.signal }), 100).then(value => { result = value })
  try {
    controller.abort()
    await vi.waitFor(() => expect(result).toEqual({ ok: false, reason: 'aborted' }), { timeout: 100 })
    expect(cancel).toHaveBeenCalledOnce(); expect(stream.locked).toBe(false)
  } finally {
    try { streamController.close() } catch { /* already cancelled */ }
    await reading
  }
})
it('does not wait indefinitely for a rejected stream cancellation', async () => {
  let finishCancel!: () => void
  const cancelled = new Promise<void>(resolve => { finishCancel = resolve })
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(101))) }, cancel: () => cancelled })
  let result: unknown
  const reading = readJsonBody(request(stream), 100).then(value => { result = value })
  try { await vi.waitFor(() => expect(result).toEqual({ ok: false, reason: 'too-large' }), { timeout: 100 }) }
  finally { finishCancel(); await reading }
})
it('rejects invalid UTF-8 rather than replacing bytes inside saved source', async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Uint8Array.from([123, 34, 120, 34, 58, 34, 255, 34, 125])); controller.close() } })
  expect(await readJsonBody(request(stream), 100)).toEqual({ ok: false, reason: 'invalid' })
})
it('accepts split multibyte UTF-8 and the exact byte limit', async () => {
  const bytes = new TextEncoder().encode('{"x":"🙂"}')
  const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close() } })
  expect(await readJsonBody(request(stream), bytes.length)).toEqual({ ok: true, data: { x: '🙂' } })
})
it.each(['application/jsonp', 'text/json', 'text/plain'])('rejects %s without reading the body', async contentType => {
  const value = request('{}', { headers: { 'content-type': contentType } })
  const reader = vi.spyOn(value.body!, 'getReader')
  expect(await readJsonBody(value, 100)).toEqual({ ok: false, reason: 'unsupported-content-type' })
  expect(reader).not.toHaveBeenCalled()
})
it('handles an already-consumed body as a validation error', async () => {
  const value = request('{}'); await value.text()
  expect(await readJsonBody(value, 100)).toEqual({ ok: false, reason: 'invalid' })
})
