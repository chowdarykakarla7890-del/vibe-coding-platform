import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { after } from 'next/server'
import { scheduleSourceCapture } from '@/lib/server/source-capture-dispatch'
import { processSourceCapture } from '@/lib/server/source-capture-worker'
import { createAdminSupabaseClient } from '@/lib/supabase/server'

vi.mock('server-only', () => ({}))
vi.mock('next/server', () => ({ after: vi.fn() }))
vi.mock('@/lib/server/source-capture-worker', () => ({ processSourceCapture: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createAdminSupabaseClient: vi.fn() }))
// Node's timer-promises implementation keeps its own native timer references.
// Route its delay through the fake global clock while preserving cancellation.
vi.mock('node:timers/promises', () => ({ setTimeout: (ms: number, _value: unknown, { signal }: { signal: AbortSignal }) => new Promise<void>((resolve, reject) => {
  signal.throwIfAborted()
  const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve() }, ms)
  function cancel() { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(signal.reason) }
  signal.addEventListener('abort', cancel, { once: true })
}) }))
let row: unknown
let error: unknown
const query = { select: vi.fn(), eq: vi.fn(), abortSignal: vi.fn(), maybeSingle: vi.fn(async () => ({ data: row, error })) }
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); error = null
  row = { state: 'queued', available_at: new Date().toISOString(), lease_until: null }
  for (const key of ['select', 'eq', 'abortSignal'] as const) query[key].mockReturnValue(query)
  vi.mocked(createAdminSupabaseClient).mockReturnValue({ from: vi.fn(() => query) } as never)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
function schedule() {
  scheduleSourceCapture('11111111-1111-4111-8111-111111111111')
  return (vi.mocked(after).mock.calls[0][0] as () => Promise<void>)()
}
it('retries a queued shutdown after another account-scoped capture held the lease', async () => {
  vi.mocked(processSourceCapture).mockResolvedValueOnce('idle').mockResolvedValueOnce('stopped')
  const task = schedule()
  await vi.advanceTimersByTimeAsync(1000); await task
  expect(processSourceCapture).toHaveBeenCalledTimes(2)
  expect(query.eq).toHaveBeenCalledWith('id', '11111111-1111-4111-8111-111111111111')
})
it.each(['done', 'incomplete', 'expired'])('does not poll terminal %s jobs', async state => {
  row = { state, available_at: new Date().toISOString(), lease_until: null }
  vi.mocked(processSourceCapture).mockResolvedValue('idle')
  await schedule()
  expect(processSourceCapture).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})
it('does not wait for a distant retry time or an already leased copy of this job', async () => {
  row = { state: 'capturing', available_at: new Date().toISOString(), lease_until: new Date(Date.now() + 90000).toISOString() }
  vi.mocked(processSourceCapture).mockResolvedValue('idle')
  await schedule()
  expect(processSourceCapture).toHaveBeenCalledOnce()
})
it('bounds repeated lease contention and leaves the durable job for the scheduler', async () => {
  vi.mocked(processSourceCapture).mockResolvedValue('idle')
  const task = schedule()
  await vi.advanceTimersByTimeAsync(45000); await task
  expect(vi.mocked(processSourceCapture).mock.calls.length).toBeGreaterThan(1)
  expect(vi.mocked(processSourceCapture).mock.calls.length).toBeLessThanOrEqual(8)
  expect(vi.getTimerCount()).toBe(0)
})
it('stops after deleted jobs or metadata failures without retrying paid work', async () => {
  row = null; error = { message: 'private database failure' }
  vi.mocked(processSourceCapture).mockResolvedValue('idle')
  await schedule()
  expect(processSourceCapture).toHaveBeenCalledOnce()
})
it('settles a stalled worker after the whole-operation deadline', async () => {
  vi.mocked(processSourceCapture).mockImplementation(() => new Promise(() => {}))
  const task = schedule()
  await vi.advanceTimersByTimeAsync(45000); await task
  expect(processSourceCapture).toHaveBeenCalledOnce()
  expect(vi.mocked(processSourceCapture).mock.calls[0][1]?.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})
