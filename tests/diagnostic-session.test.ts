import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DiagnosticSession, diagnosticHistory } from '@/lib/commands/diagnostic-session'
import type { DiagnosticCandidate } from '@/lib/commands/diagnostic-candidates'
const candidate = (key: string): DiagnosticCandidate => ({ key, line: { command: 'node', args: [], stream: 'stderr', data: `TypeError: ${key}`, timestamp: 1 } })
const summary = { shouldBeFixed: true, summary: 'Invalid code', paths: ['main.ts'] }
const sessions: DiagnosticSession[] = []
function setup() {
  const history = diagnosticHistory()
  const analyze = vi.fn().mockResolvedValue(summary), report = vi.fn().mockResolvedValue(undefined), onState = vi.fn()
  const session = new DiagnosticSession({ history, debounceMs: 100, analyze, report, onState })
  sessions.push(session)
  return { history, analyze, report, onState, session }
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100_000) })
afterEach(() => { sessions.splice(0).forEach(session => session.dispose()); vi.useRealTimers() })
describe('diagnostic session scheduling', () => {
  it('collects bursts into one current batch and does not postpone forever', async () => {
    const { session, analyze, report } = setup()
    session.update([candidate('first')])
    await vi.advanceTimersByTimeAsync(75)
    session.update([candidate('first'), candidate('second')])
    await vi.advanceTimersByTimeAsync(25)
    expect(analyze).toHaveBeenCalledOnce()
    expect(analyze.mock.calls[0][0]).toHaveLength(2)
    expect(report).toHaveBeenCalledOnce()
    session.update([candidate('first'), candidate('second')])
    await vi.advanceTimersByTimeAsync(120_000)
    expect(analyze).toHaveBeenCalledOnce()
  })
  it('counts ignored results and rate-limits new failures rather than repeating old output', async () => {
    const { session, analyze, report } = setup()
    analyze.mockResolvedValue({ shouldBeFixed: false, summary: '', paths: [] })
    session.update([candidate('first')]); await vi.advanceTimersByTimeAsync(100)
    session.update([candidate('first')]); await vi.advanceTimersByTimeAsync(100)
    session.update([candidate('second')]); await vi.advanceTimersByTimeAsync(59_899)
    expect(analyze).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(analyze).toHaveBeenCalledTimes(2)
    expect(report).not.toHaveBeenCalled()
  })
  it('pauses on failure until explicit retry, retaining the minute budget', async () => {
    const { session, analyze, onState } = setup()
    analyze.mockRejectedValueOnce(new Error('Service unavailable'))
    session.update([candidate('first')]); await vi.advanceTimersByTimeAsync(100)
    expect(onState).toHaveBeenLastCalledWith({ status: 'error', error: 'Service unavailable' })
    session.update([candidate('first'), candidate('second')]); await vi.advanceTimersByTimeAsync(10_000)
    expect(analyze).toHaveBeenCalledOnce()
    session.retry(); await vi.advanceTimersByTimeAsync(49_999)
    expect(analyze).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(analyze).toHaveBeenCalledTimes(2)
  })
  it('cancels an obsolete request and never reports its late completion', async () => {
    const { session, analyze, report, onState } = setup()
    let finish!: (value: typeof summary) => void
    analyze.mockReturnValue(new Promise(resolve => { finish = resolve }))
    session.update([candidate('first')]); await vi.advanceTimersByTimeAsync(100)
    const signal = analyze.mock.calls[0][2] as AbortSignal
    session.dispose()
    const count = onState.mock.calls.length
    finish(summary); await vi.advanceTimersByTimeAsync(0)
    expect(signal.aborted).toBe(true)
    expect(report).not.toHaveBeenCalled()
    expect(onState).toHaveBeenCalledTimes(count)
  })
  it('observes a rejected chat submission instead of leaking an unhandled promise', async () => {
    const { session, report, onState } = setup()
    report.mockRejectedValue(new Error('Chat unavailable'))
    session.update([candidate('first')]); await vi.advanceTimersByTimeAsync(100)
    expect(onState).toHaveBeenLastCalledWith({ status: 'error', error: 'Chat unavailable' })
  })
})
