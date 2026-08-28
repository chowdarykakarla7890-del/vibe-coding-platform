import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GET } from '@/app/api/internal/worker-health/route'
import { GET as cleanupArchives } from '@/app/api/internal/archive-cleanup/route'
import { evaluateWorkerHealth, observeWorker, requireWorkerAuthorization, WORKERS } from '@/lib/server/worker-health'

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({ createAdminSupabaseClient: () => ({ rpc }) }))
const now = Date.parse('2026-08-28T12:00:00Z')
const date = (age: number) => new Date(now - age).toISOString()
const runId = '11111111-1111-4111-8111-111111111111'
const secret = 'a'.repeat(48)
const request = () => new Request('https://example.test/api/internal/worker-health', { headers: { authorization: `Bearer ${secret}` } })
const rows = () => WORKERS.map(worker_name => ({ worker_name, checked_at: date(0),
  started_at: date(60_000), finished_at: date(30_000), outcome: 'succeeded', last_success_at: date(30_000), last_failure_at: null as string | null }))
const healthy = () => rows()
const status = (row: Record<string, unknown>) => evaluateWorkerHealth([row, ...rows().slice(1)]).workers[0].status
const receipt = (data: unknown, error: unknown = null) => ({ abortSignal: vi.fn(async () => ({ data, error })) })

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', secret)
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  rpc.mockImplementation((name: string) => receipt(name === 'read_worker_invocation_health' ? healthy() : name.startsWith('purge_') ? 0 : true))
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllEnvs() })

describe('worker invocation health classification', () => {
  it('returns fixed ordered workers using database time, not the host clock', () => {
    vi.useFakeTimers(); vi.setSystemTime(0)
    const result = evaluateWorkerHealth(rows().reverse())
    expect(result.status).toBe('healthy')
    expect(result.checkedAt).toBe(date(0))
    expect(result.workers.map(row => row.name)).toEqual(WORKERS)
    expect(result.workers.map(row => row.maxSuccessAgeSeconds)).toEqual([180, 180, 720])
  })
  it('never reports an unobserved worker as healthy', () => {
    expect(status({ ...rows()[0], started_at: null, finished_at: null, outcome: null, last_success_at: null })).toBe('never-run')
  })
  it('distinguishes starting, stuck and failed invocations', () => {
    const running = { ...rows()[0], outcome: 'running', finished_at: null, last_success_at: null }
    expect(status(running)).toBe('starting')
    expect(status({ ...running, started_at: date(90_000) })).toBe('starting')
    expect(status({ ...running, started_at: date(90_001) })).toBe('stuck')
    expect(status({ ...rows()[0], outcome: 'failed', last_failure_at: date(30_000) })).toBe('failed')
  })
  it('does not erase the last failure when a new invocation merely starts', () => {
    expect(status({ ...rows()[0], outcome: 'running', finished_at: null, last_success_at: date(120_000), last_failure_at: date(70_000) })).toBe('failed')
    expect(status({ ...rows()[0], last_failure_at: date(70_000) })).toBe('healthy')
  })
  it('keeps a recent successful worker healthy during a new bounded run', () => {
    expect(status({ ...rows()[0], outcome: 'running', started_at: date(10_000), finished_at: null })).toBe('healthy')
  })
  it.each([['source-capture', 180_000], ['sandbox-cleanup', 180_000], ['archive-cleanup', 720_000]] as const)('detects missed %s invocations', (name, limit) => {
    for (const extra of [0, 1]) {
      const records = rows().map(row => row.worker_name === name ? { ...row, started_at: date(limit + extra + 1), finished_at: date(limit + extra), last_success_at: date(limit + extra) } : row)
      expect(evaluateWorkerHealth(records).workers.find(row => row.name === name)?.status).toBe(extra ? 'stale' : 'healthy')
    }
  })
  it.each([
    { started_at: date(-1) }, { finished_at: null }, { last_success_at: null },
    { last_success_at: date(10_000) }, { outcome: 'failed', last_failure_at: null },
    { outcome: 'running' }, { finished_at: date(80_000) }, { outcome: null },
    { last_failure_at: date(-1) }, { started_at: null },
  ])('fails closed on inconsistent health metadata %j', patch => {
    expect(status({ ...rows()[0], ...patch })).toBe('unknown')
  })
  it.each([
    () => [], () => [...rows(), rows()[0]], () => [rows()[0], rows()[0], rows()[2]],
    () => rows().map((row, i) => i ? row : { ...row, checked_at: date(1) }),
    () => rows().map((row, i) => i ? row : { ...row, prompt: 'must not return this' }),
    () => rows().map((row, i) => i ? row : { ...row, worker_name: 'injected-worker' }),
  ])('rejects incomplete, duplicate or unexpected database responses', records => {
    expect(() => evaluateWorkerHealth(records())).toThrow()
  })
})

describe('bounded worker health receipts', () => {
  it('records start, runs once, then records completion without serializing the result', async () => {
    const run = vi.fn(async () => { expect(rpc).toHaveBeenCalledTimes(1); return { failed: 0, sensitive: 'do-not-log' } })
    expect(await observeWorker('source-capture', runId, run, value => value.failed === 0)).toEqual({ failed: 0, sensitive: 'do-not-log' })
    expect(run).toHaveBeenCalledOnce()
    expect(rpc.mock.calls).toEqual([
      ['begin_worker_invocation', { p_worker_name: 'source-capture', p_run_id: runId }],
      ['finish_worker_invocation', { p_worker_name: 'source-capture', p_run_id: runId, p_succeeded: true }],
    ])
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain('do-not-log')
  })
  it('records an unsuccessful batch without changing the route result', async () => {
    const result = { failed: 1 }
    expect(await observeWorker('sandbox-cleanup', runId, async () => result, value => value.failed === 0)).toBe(result)
    expect(rpc).toHaveBeenLastCalledWith('finish_worker_invocation', expect.objectContaining({ p_succeeded: false }))
  })
  it('records exceptions, propagates the original failure, and does not log raw errors', async () => {
    const error = new Error('private source or token')
    await expect(observeWorker('sandbox-cleanup', runId, async () => { throw error }, () => true)).rejects.toBe(error)
    expect(rpc).toHaveBeenLastCalledWith('finish_worker_invocation', expect.objectContaining({ p_succeeded: false }))
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(error.message)
  })
  it.each([false, null, 1, 'true'])('still runs cleanup after an invalid start receipt %j, without inventing completion', async data => {
    rpc.mockReturnValueOnce(receipt(data))
    const run = vi.fn(async () => true)
    await expect(observeWorker('archive-cleanup', runId, run, Boolean)).rejects.toMatchObject({ code: 'WORKER_HEALTH_UNAVAILABLE' })
    expect(run).toHaveBeenCalledOnce(); expect(rpc).toHaveBeenCalledTimes(1)
  })
  it('does not replay work after a failed completion receipt', async () => {
    rpc.mockReturnValueOnce(receipt(true)).mockReturnValueOnce(receipt(null, { message: 'private failure' }))
    const run = vi.fn(async () => true)
    await expect(observeWorker('archive-cleanup', runId, run, Boolean)).rejects.toMatchObject({ code: 'WORKER_HEALTH_UNAVAILABLE' })
    expect(run).toHaveBeenCalledOnce(); expect(rpc).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private failure')
  })
  it('accepts a fenced completion superseded by another invocation', async () => {
    rpc.mockReturnValueOnce(receipt(true)).mockReturnValueOnce(receipt(false))
    await expect(observeWorker('archive-cleanup', runId, async () => true, Boolean)).resolves.toBe(true)
  })
  it.each(['start', 'finish'] as const)('bounds a stalled %s receipt without suppressing cleanup or retrying it', async phase => {
    vi.useFakeTimers()
    let resolve!: (value: unknown) => void
    const stalled = { abortSignal: vi.fn(() => new Promise(done => { resolve = done })) }
    if (phase === 'finish') rpc.mockReturnValueOnce(receipt(true))
    rpc.mockReturnValueOnce(stalled)
    const run = vi.fn(async () => true)
    const observed = expect(observeWorker('archive-cleanup', runId, run, Boolean)).rejects.toMatchObject({ code: 'WORKER_HEALTH_UNAVAILABLE' })
    await vi.advanceTimersByTimeAsync(2_000); await observed
    expect(run).toHaveBeenCalledOnce()
    expect((stalled.abortSignal.mock.calls as unknown as [AbortSignal][])[0][0].aborted).toBe(true)
    resolve({ data: true, error: null }); await vi.advanceTimersByTimeAsync(1)
    expect(rpc).toHaveBeenCalledTimes(phase === 'start' ? 1 : 2)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('bounds stalled archive mutations and records failure rather than reporting cleanup success', async () => {
    vi.useFakeTimers()
    rpc.mockImplementation(name => name.startsWith('purge_') ? { abortSignal: vi.fn(() => new Promise(() => {})) } : receipt(true))
    const responsePromise = cleanupArchives(request())
    await vi.advanceTimersByTimeAsync(20_000)
    expect((await responsePromise).status).toBe(502)
    expect(rpc).toHaveBeenLastCalledWith('finish_worker_invocation', expect.objectContaining({ p_succeeded: false }))
    expect(rpc.mock.calls.filter(([name]) => name.startsWith('purge_'))).toHaveLength(3)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('private worker health endpoint', () => {
  it.each([undefined, '', 'short', 'a'.repeat(513)])('rejects missing or invalid configuration', async value => {
    vi.stubEnv('CRON_SECRET', value)
    expect((await GET(request())).status).toBe(503); expect(rpc).not.toHaveBeenCalled()
  })
  it.each(['', 'Bearer wrong', `Bearer ${'b'.repeat(48)}`, `Bearer ${'a'.repeat(600)}`])('rejects invalid authorization before reading health', async authorization => {
    const response = await GET(new Request(request(), { headers: { authorization } }))
    expect(response.status).toBe(401); expect(rpc).not.toHaveBeenCalled()
  })
  it('uses timing-safe comparison for multibyte mismatches without throwing a length error', () => {
    expect(() => requireWorkerAuthorization(new Request(request(), { headers: { authorization: `Bearer ${'é'.repeat(48)}` } }), 'UNCONFIGURED', 'Unavailable')).toThrow('Worker authorization is required.')
  })
  it('returns private, read-only health and request IDs without refreshing the observed workers', async () => {
    const response = await GET(request())
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('X-Request-Id')).toBeTruthy()
    expect((await response.json()).status).toBe('healthy')
    expect(rpc.mock.calls).toEqual([['read_worker_invocation_health']])
  })
  it('returns 503 when any worker has missed its freshness window', async () => {
    rpc.mockReturnValue(receipt(rows().map(row => ({ ...row, started_at: date(800_000), finished_at: date(799_000), last_success_at: date(799_000) }))))
    const response = await GET(request())
    expect(response.status).toBe(503); expect((await response.json()).status).toBe('degraded')
  })
  it.each([receipt(null, { message: 'private database failure' }), receipt([])])('redacts database failure and malformed receipts', async value => {
    rpc.mockReturnValue(value)
    const response = await GET(request())
    expect(response.status).toBe(503)
    expect((await response.json()).error.code).toBe('WORKER_HEALTH_UNAVAILABLE')
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('private database failure')
  })
  it('bounds even an uncooperative health read to four seconds', async () => {
    vi.useFakeTimers()
    rpc.mockReturnValue({ abortSignal: () => new Promise(() => {}) })
    const pending = GET(request())
    await vi.advanceTimersByTimeAsync(4_000)
    expect((await pending).status).toBe(503); expect(vi.getTimerCount()).toBe(0)
  })
  it('does not dispatch a database request after caller cancellation', async () => {
    const controller = new AbortController(); controller.abort()
    expect((await GET(new Request(request(), { signal: controller.signal }))).status).toBe(503)
    expect(rpc).not.toHaveBeenCalled()
  })
})
