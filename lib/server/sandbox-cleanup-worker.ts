import 'server-only'
import { Sandbox } from '@vercel/sandbox'
import { z } from 'zod'
import { createAdminSupabaseClient } from '@/lib/supabase/server'
import { getSandboxCredentials, isSandboxUnavailableError } from '@/ai/sandbox'
import { abortableRead } from '@/lib/abortable-read'

const leaseSchema = z.object({ id: z.string().uuid(), lease_token: z.string().uuid() })
const jobSchema = leaseSchema.extend({ sandbox_name: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/) })
type Outcome = 'stopped' | 'unavailable' | 'retry'

/** Only database-owned handles can reach the provider. No caller supplies a VM
 * name, identity, or credentials. The lease survives process/request loss. */
export async function processSandboxCleanup(jobId?: string, callerSignal?: AbortSignal) {
  if (jobId !== undefined) z.string().uuid().parse(jobId)
  const started = Date.now()
  const signal = AbortSignal.any([AbortSignal.timeout(25_000), ...(callerSignal ? [callerSignal] : [])])
  const admin = createAdminSupabaseClient()
  const claimed = await abortableRead(async () => await admin.rpc('claim_sandbox_cleanup', { p_job_id: jobId }).abortSignal(signal), signal)
  if (claimed.error) throw new Error('Sandbox cleanup claim unavailable.')
  if (!claimed.data) return 'idle' as const
  const lease = leaseSchema.parse(claimed.data)
  let outcome: Outcome = 'retry'
  try {
    const job = jobSchema.parse(claimed.data)
    const box = await abortableRead(() => Sandbox.get({ name: job.sandbox_name, resume: false,
      signal, ...getSandboxCredentials() }), signal)
    // Never wake a VM to clean it up; stopped is already a valid receipt.
    let status: string | undefined
    try { status = box.status } catch { /* Named sandbox has no current session. */ }
    if (status === 'stopped') outcome = 'stopped'
    else if (!status || status === 'failed' || status === 'aborted') outcome = 'unavailable'
    else {
      const receipt = await abortableRead(() => box.stop({ signal }), signal)
      // SDK stop returns the final session, not an unqualified HTTP success.
      if (receipt.status === 'stopped') outcome = 'stopped'
    }
  } catch (error) {
    if (isSandboxUnavailableError(error)) outcome = 'unavailable'
  }
  // Release with an independent deadline; a cancelled browser cannot prevent
  // persistence. A lost settlement is not settled a second time with a new result.
  const settlementSignal = AbortSignal.timeout(5_000)
  const settled = await abortableRead(async () => await admin.rpc('settle_sandbox_cleanup', {
    p_job_id: lease.id, p_lease_token: lease.lease_token, p_outcome: outcome,
  }).abortSignal(settlementSignal), settlementSignal)
  if (settled.error || settled.data !== true) throw new Error('Sandbox cleanup settlement unconfirmed.')
  console.info('Sandbox cleanup lifecycle', { jobId: lease.id, outcome, durationMs: Date.now() - started })
  return outcome
}

/** Independent from source-capture workers: cleanup cannot starve final saves.
 * At most two concurrent provider operations and ten jobs per invocation. */
export async function runSandboxCleanupBatch(jobIds?: string[]) {
  const ids = jobIds ? [...new Set(z.array(z.string().uuid()).max(200).parse(jobIds))].slice(0, 10) : undefined
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 45_000)
  let claimed = 0, processed = 0, failed = 0, unconfirmed = 0
  try {
    await Promise.all(Array.from({ length: 2 }, async () => {
      while (!controller.signal.aborted && claimed < (ids?.length ?? 10)) {
        const index = claimed++
        try {
          const outcome = await processSandboxCleanup(ids?.[index], controller.signal)
          if (outcome === 'idle') { if (ids) continue; break }
          processed++
          if (outcome === 'retry') failed++
          if (outcome === 'unavailable') unconfirmed++
        } catch { failed++; break }
      }
    }))
    return { processed, failed, unconfirmed }
  } finally { clearTimeout(timer); controller.abort() }
}
