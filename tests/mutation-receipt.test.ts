import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { awaitMutationReceipt, MutationReceiptTimeoutError } from '@/lib/mutation-receipt'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('bounded mutation receipts', () => {
  it('returns one receipt and clears the timer without aborting a completed request', async () => {
    let signal!: AbortSignal
    const request = vi.fn(async (value: AbortSignal) => { signal = value; return { revision: 2 } })
    await expect(awaitMutationReceipt(request, new AbortController().signal, 100, 'Unconfirmed')).resolves.toEqual({ revision: 2 })
    expect(request).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(101)
    expect(signal.aborted).toBe(false)
  })

  it('does not dispatch when already cancelled', async () => {
    const caller = new AbortController()
    caller.abort()
    const request = vi.fn()
    await expect(awaitMutationReceipt(request, caller.signal, 100, 'Unconfirmed')).rejects.toMatchObject({ name: 'AbortError' })
    expect(request).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not dispatch after cancellation in the same tick', async () => {
    const caller = new AbortController()
    const request = vi.fn()
    const pending = awaitMutationReceipt(request, caller.signal, 100, 'Unconfirmed')
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    caller.abort()
    await assertion
    expect(request).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['timeout', 'caller'] as const)('settles on %s even when the transport ignores cancellation, observing late failures', async (cause) => {
    const caller = new AbortController()
    let signal!: AbortSignal
    let rejectLate!: (reason: Error) => void
    const request = vi.fn((value: AbortSignal) => {
      signal = value
      return new Promise<never>((_resolve, reject) => { rejectLate = reject })
    })
    const pending = awaitMutationReceipt(request, caller.signal, 100, 'Write outcome unknown')
    const assertion = expect(pending).rejects.toMatchObject({ name: cause === 'timeout' ? 'MutationReceiptTimeoutError' : 'AbortError' })
    await vi.advanceTimersByTimeAsync(0)
    if (cause === 'caller') caller.abort()
    else await vi.advanceTimersByTimeAsync(101)
    await assertion
    expect(signal.aborted).toBe(true)
    expect(request).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    rejectLate(new Error('Late transport failure'))
    await vi.advanceTimersByTimeAsync(0)
  })

  it('ignores a late successful receipt rather than turning timeout into success', async () => {
    let resolveLate!: (value: string) => void
    const success = vi.fn(), failure = vi.fn()
    const pending = awaitMutationReceipt(() => new Promise<string>(resolve => { resolveLate = resolve }), new AbortController().signal, 100, 'Write outcome unknown')
      .then(success, failure)
    await vi.advanceTimersByTimeAsync(101)
    await pending
    resolveLate('saved')
    await vi.advanceTimersByTimeAsync(0)
    expect(success).not.toHaveBeenCalled()
    expect(failure).toHaveBeenCalledExactlyOnceWith(expect.any(MutationReceiptTimeoutError))
  })

  it.each(['throw', 'reject'] as const)('propagates an immediate %s and removes the timer', async (mode) => {
    const failure = new Error('Read failed')
    const request = vi.fn(() => { if (mode === 'throw') throw failure; return Promise.reject(failure) })
    await expect(awaitMutationReceipt(request, new AbortController().signal, 100, 'Unconfirmed')).rejects.toBe(failure)
    expect(request).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
