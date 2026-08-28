import 'server-only'
import { z } from 'zod'
import { timingSafeEqual } from 'node:crypto'
import { ApiError } from './api'
import { createAdminSupabaseClient } from '@/lib/supabase/server'
import { awaitMutationReceipt } from '@/lib/mutation-receipt'
import { readWithDeadline } from '@/lib/abortable-read'

export const WORKERS = ['source-capture', 'sandbox-cleanup', 'archive-cleanup'] as const
export type WorkerName = typeof WORKERS[number]
const limits: Record<WorkerName, number> = { 'source-capture': 180_000, 'sandbox-cleanup': 180_000, 'archive-cleanup': 720_000 }
const timestamp = z.string().datetime({ offset: true }).nullable()
const rowSchema = z.object({
  worker_name: z.enum(WORKERS), started_at: timestamp, finished_at: timestamp,
  outcome: z.enum(['running', 'succeeded', 'failed']).nullable(),
  last_success_at: timestamp, last_failure_at: timestamp,
  checked_at: z.string().datetime({ offset: true }),
}).strict()

export function requireWorkerAuthorization(request: Request, code: string, message: string) {
  const secret = process.env.CRON_SECRET
  if (!secret || secret.length < 32 || secret.length > 512) throw new ApiError(503, code, message)
  const header = request.headers.get('authorization') ?? ''
  if (header.length > 520) throw new ApiError(401, 'WORKER_AUTH_REQUIRED', 'Worker authorization is required.')
  const provided = Buffer.from(header), expected = Buffer.from(`Bearer ${secret}`)
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new ApiError(401, 'WORKER_AUTH_REQUIRED', 'Worker authorization is required.')
  }
}

/** Records only fixed outcomes. A timed-out write may still commit; it is not
 * retried or rolled back. Independent deadlines keep telemetry from starving
 * the actual safety worker. Old completions are fenced by the database. */
export async function observeWorker<T>(worker: WorkerName, requestId: string, run: () => Promise<T>, succeeded: (result: T) => boolean): Promise<T> {
  const started = Date.now()
  async function record(phase: 'start' | 'finish', success = false) {
    try {
      const receipt = await awaitMutationReceipt(async signal => {
        const admin = createAdminSupabaseClient()
        return await (phase === 'start'
          ? admin.rpc('begin_worker_invocation', { p_worker_name: worker, p_run_id: requestId })
          : admin.rpc('finish_worker_invocation', { p_worker_name: worker, p_run_id: requestId, p_succeeded: success })).abortSignal(signal)
      }, new AbortController().signal, 2_000, 'Worker health receipt timed out.')
      if (receipt.error || typeof receipt.data !== 'boolean') throw new Error('Unconfirmed health receipt')
      // A newer run can supersede this completion. It owns the health record.
      if (phase === 'start' && receipt.data !== true) throw new Error('Unconfirmed health start')
      return true
    } catch {
      console.warn('Worker health recording unavailable', { worker, requestId, phase, durationMs: Date.now() - started })
      return false
    }
  }
  console.info('Worker invocation lifecycle', { worker, requestId, phase: 'start' })
  const recordedStart = await record('start')
  let result: T
  let success = false
  try { result = await run(); success = succeeded(result) }
  catch (error) {
    if (recordedStart) await record('finish', false)
    console.warn('Worker invocation lifecycle', { worker, requestId, phase: 'failed', durationMs: Date.now() - started })
    throw error
  }
  const recordedFinish = recordedStart && await record('finish', success)
  console.info('Worker invocation lifecycle', { worker, requestId, phase: success ? 'done' : 'failed', durationMs: Date.now() - started, healthRecorded: recordedFinish })
  if (!recordedFinish) throw new ApiError(503, 'WORKER_HEALTH_UNAVAILABLE', 'The worker ran, but its health receipt could not be confirmed. Check worker health before retrying.')
  return result
}

export function evaluateWorkerHealth(input: unknown) {
  const rows = z.array(rowSchema).length(WORKERS.length).parse(input)
  if (new Set(rows.map(row => row.worker_name)).size !== WORKERS.length || new Set(rows.map(row => row.checked_at)).size !== 1) {
    throw new Error('Incomplete worker health snapshot')
  }
  const checkedAt = rows[0].checked_at, now = Date.parse(checkedAt)
  const workers = WORKERS.map(name => {
    const row = rows.find(item => item.worker_name === name)!
    const started = row.started_at === null ? null : Date.parse(row.started_at)
    const finished = row.finished_at === null ? null : Date.parse(row.finished_at)
    const success = row.last_success_at === null ? null : Date.parse(row.last_success_at)
    const failure = row.last_failure_at === null ? null : Date.parse(row.last_failure_at)
    const invalid = [started, finished, success, failure].some(time => time !== null && time > now) ||
      (started === null && [row.outcome, finished, success, failure].some(value => value !== null)) ||
      (started !== null && (row.outcome === null || (row.outcome === 'running' ? finished !== null : finished === null || finished < started))) ||
      (row.outcome === 'succeeded' && (success === null || success !== finished)) ||
      (row.outcome === 'failed' && (failure === null || failure !== finished))
    const status = invalid ? 'unknown'
      : started === null ? 'never-run'
      : row.outcome === 'failed' || (failure !== null && (success === null || failure >= success)) ? 'failed'
      : row.outcome === 'running' && now - started > 90_000 ? 'stuck'
      : success === null ? 'starting'
      : now - success > limits[name] ? 'stale' : 'healthy'
    return { name, status, lastStartedAt: row.started_at, lastFinishedAt: row.finished_at,
      lastSucceededAt: row.last_success_at, lastFailedAt: row.last_failure_at, maxSuccessAgeSeconds: limits[name] / 1000 }
  })
  return { status: workers.every(worker => worker.status === 'healthy') ? 'healthy' : 'degraded', checkedAt, workers }
}

export async function readWorkerHealth(signal: AbortSignal) {
  try {
    const result = await readWithDeadline(async deadline => {
      return await createAdminSupabaseClient().rpc('read_worker_invocation_health').abortSignal(deadline)
    }, signal, 4_000, 'Worker health read timed out.')
    if (result.error) throw new Error('Worker health unavailable')
    return evaluateWorkerHealth(result.data)
  } catch {
    throw new ApiError(503, 'WORKER_HEALTH_UNAVAILABLE', 'Worker health could not be confirmed. Check the database connection and retry.')
  }
}
