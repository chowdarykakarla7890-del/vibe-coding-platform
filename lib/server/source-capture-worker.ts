import 'server-only'
import { Sandbox } from '@vercel/sandbox'
import { z } from 'zod'
import { getSandboxCredentials, isSandboxUnavailableError } from '@/ai/sandbox'
import { createAdminSupabaseClient } from '@/lib/supabase/server'
import { captureSandboxSource, SourceCaptureError } from '@/lib/sandbox/source-capture'
import { acknowledgeSandboxCapture } from '@/lib/sandbox/source-ack'
import { isSafeSnapshotPath } from '@/lib/learning/snapshots'
import { abortableRead } from '@/lib/abortable-read'
import { readCommandExitCode } from './command-status'
import { quiesceSandboxRuntime } from '@/lib/sandbox/shutdown-guard'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const acknowledgements = z.array(z.object({ path: z.string().refine(isSafeSnapshotPath),
  revision: z.number().int().positive().max(2_147_483_647), digest: digest.nullable() })).max(400)
  .refine((items) => new Set(items.map((item) => item.path)).size === items.length)
const jobSchema = z.object({
  id: z.string().uuid(), user_id: z.string().uuid(), project_id: z.string().uuid(),
  sandbox_session_id: z.string().uuid(), sandbox_id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  sandbox_status: z.string(), expires_at: z.string().datetime({ offset: true }),
  state: z.enum(['capturing', 'acknowledging']), lease_token: z.string().uuid(),
  command_id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).nullable(), command_status: z.string(),
  baseline: z.array(z.object({ path: z.string().refine(isSafeSnapshotPath), revision: z.number().int().positive(), digest })).max(200),
  acknowledgements,
  purpose: z.enum(['command', 'shutdown']).default('command'),
  capture_complete: z.boolean().default(false), capture_terminal: z.boolean().default(false),
  quiesced_at: z.string().datetime({ offset: true }).nullable().default(null),
})
const receiptSchema = z.object({ acknowledgements, conflicted: z.boolean(), complete: z.boolean() })
const activeCommands = new Set(['starting', 'running', 'unknown'])
class ExpiredCapture extends Error {}
class CapturePersistenceError extends Error {}
type CaptureAction = 'acknowledged' | 'rescan' | 'retry' | 'expired' | 'stopped' | 'incomplete'

async function captureBeforeShutdown(job: z.infer<typeof jobSchema>, admin: ReturnType<typeof createAdminSupabaseClient>, signal: AbortSignal): Promise<CaptureAction> {
  if (['stopped', 'expired', 'failed'].includes(job.sandbox_status) || Date.parse(job.expires_at) <= Date.now()) return 'expired'
  if (job.sandbox_status !== 'stopping') throw new CapturePersistenceError('Shutdown reservation is not active.')
  async function advance(action: 'quiesced' | 'ready') {
    const receipt = await admin.rpc('advance_sandbox_shutdown', { p_job_id: job.id, p_lease_token: job.lease_token, p_action: action }).abortSignal(signal)
    if (receipt.error || receipt.data !== true) throw new CapturePersistenceError('Shutdown checkpoint unconfirmed.')
  }
  const sandbox = await Sandbox.get({ name: job.sandbox_id, resume: false,
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), ...getSandboxCredentials() })
  let vm
  try { vm = sandbox.currentSession() } catch { return 'expired' }
  if (vm.status === 'pending') throw new SourceCaptureError('SOURCE_VM_PENDING')
  if (vm.status !== 'running') return 'expired'
  if (job.state === 'capturing') {
    await quiesceSandboxRuntime(vm, signal)
    await advance('quiesced')
    const captured = await captureSandboxSource(vm, job.baseline.map((file) => file.path), signal)
    const persisted = await admin.rpc('reconcile_source_capture', { p_job_id: job.id,
      p_lease_token: job.lease_token, p_capture: captured, p_terminal: true }).abortSignal(signal)
    if (persisted.error) throw new CapturePersistenceError('Final source save unconfirmed.')
    const receipt = receiptSchema.parse(persisted.data)
    if (!receipt.complete) return 'incomplete'
  } else if (!job.capture_complete || !job.capture_terminal || !job.quiesced_at) {
    return 'incomplete'
  }
  // The source (or both conflicting copies) is durable. No VM journal ACK is
  // needed for a VM that must never accept writes again. Fence immediately
  // before Stop; lost Stop/database responses resume this checkpoint safely.
  await advance('ready')
  signal.throwIfAborted()
  await vm.stop({ signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) })
  return 'stopped'
}

/** No browser identity or caller-supplied sandbox is used. The private claim RPC
 * returns the immutable owner/project/session links created at reservation. */
export async function processSourceCapture(jobId?: string, callerSignal?: AbortSignal) {
  if (jobId !== undefined) z.string().uuid().parse(jobId)
  const started = Date.now()
  const signal = AbortSignal.any([AbortSignal.timeout(50_000), ...(callerSignal ? [callerSignal] : [])])
  signal.throwIfAborted()
  const admin = createAdminSupabaseClient()
  const claimed = await admin.rpc('claim_source_capture', { p_job_id: jobId }).abortSignal(signal)
  if (claimed.error) {
    console.warn('Source capture failed', {
      stage: 'claim', jobId,
      errorCode: /^(?:[0-9A-Z]{5}|PGRST\d{3})$/.test(claimed.error.code ?? '') ? claimed.error.code : 'UNAVAILABLE',
      durationMs: Date.now() - started,
    })
    throw new CapturePersistenceError('Capture claim failed.')
  }
  if (!claimed.data) return 'idle' as const
  const lease = z.object({ id: z.string().uuid(), lease_token: z.string().uuid(), purpose: z.enum(['command', 'shutdown']).default('command') }).parse(claimed.data)
  async function settle(action: CaptureAction) {
    // A cancelled request cannot prevent releasing a lease. The token fences
    // this short independent cleanup from a replacement worker.
    const result = await admin.rpc(lease.purpose === 'shutdown' ? 'advance_sandbox_shutdown' : 'settle_source_capture', {
      p_job_id: lease.id, p_lease_token: lease.lease_token, p_action: action,
    }).abortSignal(AbortSignal.timeout(5_000))
    if (result.error || !result.data) throw new CapturePersistenceError('Capture settlement unconfirmed.')
    console.info('Source capture lifecycle', { jobId: lease.id, outcome: action, durationMs: Date.now() - started })
    return action
  }
  let action: CaptureAction
  try {
    // Malformed payloads still release a validated lease through the bounded
    // retry path; no raw validation/source details enter logs.
    const job = jobSchema.parse(claimed.data)
    if (job.purpose === 'shutdown') {
      action = await captureBeforeShutdown(job, admin, signal)
    } else {
    if (job.sandbox_status !== 'running' || Date.parse(job.expires_at) <= Date.now()) throw new ExpiredCapture()
    const sandbox = await abortableRead(() => Sandbox.get({ name: job.sandbox_id, resume: false,
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), ...getSandboxCredentials() }), signal)
    let vm
    try { vm = sandbox.currentSession() } catch { throw new ExpiredCapture() }
    if (vm.status === 'pending') throw new SourceCaptureError('SOURCE_VM_PENDING')
    if (vm.status !== 'running') throw new ExpiredCapture()
    let acks = job.acknowledgements
    if (job.state === 'capturing') {
      let terminal = !activeCommands.has(job.command_status)
      if (!terminal && job.command_id) {
        try {
          const command = await abortableRead(() => vm.getCommand(job.command_id!, { signal }), signal)
          const exitCode = await readCommandExitCode(command, signal)
          if (exitCode !== null) {
            const finished = await admin.rpc('finish_command_execution', { p_user_id: job.user_id,
              p_reservation_id: job.id, p_status: 'done', p_exit_code: exitCode }).abortSignal(signal)
            if (finished.error) throw new CapturePersistenceError('Command completion could not be recorded.')
            terminal = true
          }
        } catch (error) {
          // An unavailable command record is not proof that the VM expired.
          // Capture its current files and retain the uncertain completion state.
          if (!isSandboxUnavailableError(error)) throw error
        }
      }
      // terminal is captured BEFORE scanning. Completion mid-scan schedules
      // another scan rather than declaring an older running snapshot final.
      const captured = await captureSandboxSource(vm, job.baseline.map((file) => file.path), signal)
      const persisted = await admin.rpc('reconcile_source_capture', { p_job_id: job.id,
        p_lease_token: job.lease_token, p_capture: captured, p_terminal: terminal }).abortSignal(signal)
      if (persisted.error) throw new CapturePersistenceError('Source reconciliation could not be confirmed.')
      acks = receiptSchema.parse(persisted.data).acknowledgements
    }
    // This checkpoint is already durable. A process restart resumes ACK and
    // does not reinterpret the same terminal edit against a different baseline.
    if (acks.length) await acknowledgeSandboxCapture(vm, acks, signal)
    action = 'acknowledged'
    }
  } catch (error) {
    if (error instanceof ExpiredCapture || isSandboxUnavailableError(error)) action = 'expired'
    else if (error instanceof SourceCaptureError && ['SOURCE_WORKSPACE_CHANGED', 'SOURCE_SUPERSEDED', 'SOURCE_REVISION_MISMATCH'].includes(error.code)) {
      // The saved copy is already safe; rescan the newer VM bytes, never rewrite
      // them to force acknowledgment of an older captured version.
      action = 'rescan'
    }
    else action = 'retry'
  }
  // A failed settlement is not another capture failure: don't try to settle
  // the same possibly-lost lease twice with conflicting outcomes.
  return settle(action)
}

/** Two bounded lanes drain at most ten due jobs per invocation. Leases provide
 * cross-process deduplication; this requires no in-memory singleton or browser. */
export async function runSourceCaptureBatch() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 50_000)
  let claimed = 0, processed = 0, failed = 0
  try {
    await Promise.all(Array.from({ length: 2 }, async () => {
      while (!controller.signal.aborted && claimed < 10) {
        claimed += 1
        try {
          const outcome = await processSourceCapture(undefined, controller.signal)
          if (outcome === 'idle') break
          processed += 1
          if (outcome === 'retry') failed += 1
        } catch {
          failed += 1
          break
        }
      }
    }))
    return { processed, failed }
  } finally { clearTimeout(timer) }
}
