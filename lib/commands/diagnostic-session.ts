import type { DiagnosticCandidate } from './diagnostic-candidates'
import type { Line, DiagnosticSummary } from '@/components/error-monitor/schemas'

export type DiagnosticState = { status: 'ready' | 'pending' | 'disabled' | 'error'; error?: string }
export interface DiagnosticHistory {
  seen: Set<string>
  lastAttemptAt: number
  previous: Line[]
  failure?: { keys: string[]; message: string }
}
export function diagnosticHistory(): DiagnosticHistory {
  return { seen: new Set(), lastAttemptAt: -Infinity, previous: [] }
}

/** One cancellable subscriber; no cursor based on a rolling log-array length. */
export class DiagnosticSession {
  private disposed = false
  private timer?: ReturnType<typeof setTimeout>
  private request?: AbortController
  private candidates: DiagnosticCandidate[] = []
  constructor(private options: {
    history: DiagnosticHistory
    debounceMs: number
    analyze: (lines: Line[], previous: Line[], signal: AbortSignal) => Promise<DiagnosticSummary>
    report: (summary: DiagnosticSummary, signal: AbortSignal) => Promise<void>
    onState: (state: DiagnosticState) => void
  }) {}

  update(candidates: DiagnosticCandidate[]) {
    this.candidates = candidates
    this.schedule()
  }

  retry() {
    if (this.disposed || !this.options.history.failure) return
    for (const key of this.options.history.failure.keys) this.options.history.seen.delete(key)
    this.options.history.failure = undefined
    this.schedule()
  }

  dispose() {
    this.disposed = true
    clearTimeout(this.timer)
    this.request?.abort()
  }

  private schedule() {
    const { history, onState } = this.options
    if (this.disposed || this.request) return
    if (history.failure) { onState({ status: 'error', error: history.failure.message }); return }
    if (!this.candidates.some(candidate => !history.seen.has(candidate.key))) {
      clearTimeout(this.timer)
      this.timer = undefined
      onState({ status: 'ready' })
      return
    }
    if (this.timer) return
    onState({ status: 'pending' })
    // New output updates the pending batch without continuously postponing it.
    const delay = Math.max(this.options.debounceMs, history.lastAttemptAt + 60_000 - Date.now())
    this.timer = setTimeout(() => { this.timer = undefined; void this.run() }, delay)
  }

  private async run() {
    if (this.disposed) return
    const { history, analyze, report, onState } = this.options
    const batch = this.candidates.filter(candidate => !history.seen.has(candidate.key)).slice(-4)
    if (!batch.length) { this.schedule(); return }
    const controller = new AbortController()
    this.request = controller
    history.lastAttemptAt = Date.now()
    // Count attempted, ignored and failed classifications too, not just fixes.
    for (const candidate of batch) history.seen.add(candidate.key)
    while (history.seen.size > 256) history.seen.delete(history.seen.values().next().value!)
    try {
      const summary = await analyze(batch.map(item => item.line), history.previous, controller.signal)
      if (this.disposed || controller.signal.aborted) return
      history.previous = batch.map(item => item.line)
      if (summary.shouldBeFixed) await report(summary, controller.signal)
    } catch (error) {
      if (this.disposed || controller.signal.aborted) return
      history.failure = { keys: batch.map(item => item.key), message: error instanceof Error ? error.message : 'Automatic diagnostics could not finish. You can retry or use Help debug.' }
      onState({ status: 'error', error: history.failure.message })
    } finally {
      this.request = undefined
      if (!this.disposed) this.schedule()
    }
  }
}
