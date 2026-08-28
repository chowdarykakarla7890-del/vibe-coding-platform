import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSummary } from '@/components/error-monitor/get-summary'
import { setCloudAccount } from '@/lib/learning/cloud-request'
const line = { command: 'node', args: [], stream: 'stderr' as const, data: 'TypeError: invalid', timestamp: 1 }
const summary = { shouldBeFixed: true, summary: 'Check input', paths: ['main.js'] }
const account = '11111111-1111-4111-8111-111111111111'
const fetcher = vi.fn<typeof fetch>()
beforeEach(() => { setCloudAccount(account); vi.stubGlobal('fetch', fetcher); fetcher.mockResolvedValue(Response.json(summary)) })
afterEach(() => { setCloudAccount(undefined); vi.resetAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
describe('bounded error-summary request', () => {
  it('uses the originating account and validates the response', async () => {
    await expect(getSummary('owned', [line], [])).resolves.toEqual(summary)
    expect(fetcher.mock.calls[0][1]?.credentials).toBe('same-origin')
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('X-CodeTutor-Account')).toBe(account)
  })
  it.each(['headers', 'body'])('settles stalled %s without retry or late success', async phase => {
    vi.useFakeTimers()
    let finish!: (value: unknown) => void
    const pending = new Promise(resolve => { finish = resolve })
    fetcher.mockReturnValueOnce(phase === 'headers' ? pending as Promise<Response> : Promise.resolve({ ok: true, json: () => pending } as Response))
    const task = expect(getSummary('owned', [line], [])).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(50_001)
    await task
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
    finish(phase === 'headers' ? Response.json(summary) : summary)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('cancels the old account before an unresponsive body can publish', async () => {
    fetcher.mockResolvedValueOnce({ ok: true, json: () => new Promise(() => {}) } as Response)
    const task = expect(getSummary('owned', [line], [])).rejects.toThrow()
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    setCloudAccount('22222222-2222-4222-8222-222222222222')
    await task
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
  })
  it.each([{}, { ...summary, summary: '' }, { ...summary, summary: 'x'.repeat(8001) }])('rejects invalid result bodies', async value => {
    fetcher.mockResolvedValueOnce(Response.json(value))
    await expect(getSummary('owned', [line], [])).rejects.toThrow('invalid response')
  })
  it('keeps UTF-8 JSON below the request limit without mutating incoming records', async () => {
    const lines = Array.from({ length: 4 }, () => ({ ...line, data: '😀'.repeat(8000) }))
    const before = structuredClone(lines)
    await getSummary('owned', lines, lines)
    const encoded = fetcher.mock.calls[0][1]?.body as string
    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThanOrEqual(96 * 1024)
    expect(lines).toEqual(before)
    expect(JSON.parse(encoded).previous).toEqual([])
  })
})
