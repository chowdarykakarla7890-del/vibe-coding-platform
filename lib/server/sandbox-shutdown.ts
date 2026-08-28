import 'server-only'
import { ApiError, requireOwnedSandboxRecord, type AuthContext } from './api'
import { createAdminSupabaseClient } from '@/lib/supabase/server'
import { scheduleSourceCapture } from './source-capture-dispatch'
import { consumeQuota } from './rate-limit'
import type { SandboxLifecycle } from '@/lib/sandbox/lifecycle'
import { z } from 'zod'

export async function readOwnedShutdown(auth: AuthContext, session: Awaited<ReturnType<typeof requireOwnedSandboxRecord>>): Promise<SandboxLifecycle | undefined> {
  const { data: job, error } = await auth.supabase.from('source_capture_jobs')
    .select('id,state,capture_complete,capture_terminal,quiesced_at,has_conflicts')
    .eq('sandbox_session_id', session.id).eq('user_id', auth.user.id).eq('purpose', 'shutdown')
    .abortSignal(AbortSignal.timeout(10_000)).maybeSingle()
  if (error) throw new ApiError(502, 'SHUTDOWN_STATUS_UNAVAILABLE', 'Could not check shutdown progress. Your saved source has not been cleared.')
  if (!job) return undefined
  const ended = ['stopped', 'expired', 'failed'].includes(session.status) || Date.parse(session.expires_at) <= Date.now()
  const saved = job.capture_complete && job.capture_terminal && Boolean(job.quiesced_at)
  return {
    status: ended ? 'stopped' : 'stopping',
    shutdown: { jobId: job.id, saved, hasConflicts: job.has_conflicts,
      state: ended ? saved ? 'saved' : 'incomplete' : job.state === 'incomplete' ? 'retryable' : 'saving' },
  }
}

/** Durable reservation first; post-response processing survives browser loss.
 * The scheduler retries after a crashed request. Explicit retries do not reopen
 * command admission or create another VM. Destructive project deletion is a
 * separate, explicitly confirmed workflow, not this source-preserving Stop. */
export async function requestOwnedShutdown(auth: AuthContext, sandboxId: string) {
  await requireOwnedSandboxRecord(sandboxId, auth)
  await consumeQuota(auth.user.id, 'sandbox-stop')
  const { data, error } = await createAdminSupabaseClient().rpc('begin_sandbox_shutdown', {
    p_user_id: auth.user.id, p_sandbox_id: sandboxId,
  }).abortSignal(AbortSignal.timeout(15_000))
  if (error?.message === 'SANDBOX_NOT_FOUND') throw new ApiError(404, 'SANDBOX_NOT_FOUND', 'Sandbox not found.')
  if (error || !z.string().uuid().safeParse(data).success) throw new ApiError(502, 'SHUTDOWN_UNCONFIRMED', 'Could not confirm shutdown. Check its status before retrying; no source was intentionally discarded.')
  scheduleSourceCapture(data as string)
  const session = await requireOwnedSandboxRecord(sandboxId, auth)
  const lifecycle = await readOwnedShutdown(auth, session)
  if (!lifecycle) throw new ApiError(502, 'SHUTDOWN_UNCONFIRMED', 'Shutdown status is unavailable. Retry checking its progress.')
  return { ...lifecycle, stopped: lifecycle.status === 'stopped' }
}
