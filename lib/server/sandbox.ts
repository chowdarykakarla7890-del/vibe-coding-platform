import 'server-only'
import { Sandbox } from '@vercel/sandbox'
import { z } from 'zod'
import { getSandboxCredentials, isSandboxUnavailableError } from '@/ai/sandbox'
import { createAdminSupabaseClient } from '@/lib/supabase/server'
import { ApiError, assertSameOrigin, requireOwnedProject, requireOwnedSandbox, requireUser, type AuthContext } from './api'
import { consumeQuota } from './rate-limit'
import { isDSALanguage } from '@/lib/learning/dsa-foundations'
import { isTrustedDSAId } from '@/lib/learning/dsa'
import { hasTrustedChallengeGrader } from '@/lib/learning/challenges/contracts'
import { prepareDSARuntime } from '@/lib/sandbox/dsa-runtime'
import { prepareLearningCompiler } from '@/lib/sandbox/learning-compiler'
import { curatedCompiler } from '@/lib/learning/compiled-activity'
import { scheduleSandboxCleanup } from './sandbox-cleanup-dispatch'
import { previewOriginSchema, previewPortSchema, type PreviewReceipt } from '@/lib/sandbox/preview'
import { readWithDeadline } from '@/lib/abortable-read'
import { awaitMutationReceipt } from '@/lib/mutation-receipt'

export const sandboxSettingsSchema = z.object({
  ports: z.array(z.number().int().min(1024).max(65535)).min(1).max(4).default([3000]),
  timeout: z.number().int().min(600_000).max(2_700_000).default(1_800_000),
})

export async function createOwnedSandbox(auth: AuthContext, projectId: string, settings: z.input<typeof sandboxSettingsSchema>, signal?: AbortSignal) {
  const checkActive = () => {
    if (signal?.aborted) throw new ApiError(408, 'SANDBOX_START_CANCELLED', 'Sandbox startup was cancelled. Previously saved source has been kept.')
  }
  checkActive()
  const project = await requireOwnedProject(projectId, auth)
  checkActive()
  const { ports, timeout } = sandboxSettingsSchema.parse(settings)
  await consumeQuota(auth.user.id, 'sandbox-create-hour')
  await consumeQuota(auth.user.id, 'sandbox-create-day')
  checkActive()
  const admin = createAdminSupabaseClient()
  const { data: reservation, error } = await admin.rpc('reserve_sandbox_session', { p_user_id: auth.user.id, p_project_id: projectId, p_ports: [...new Set(ports)] })
  if (error?.message === 'PROJECT_SANDBOX_ACTIVE') throw new ApiError(409, 'SANDBOX_ACTIVE', 'This project has an active sandbox or cleanup is still pending. Reopen the project or retry after cleanup finishes.')
  if (error?.message === 'SANDBOX_QUOTA') throw new ApiError(429, 'SANDBOX_QUOTA', 'Stop an active sandbox before creating another. You can run two at a time.')
  if (error?.message === 'PROJECT_NOT_FOUND') throw new ApiError(404, 'PROJECT_NOT_FOUND', 'Project not found.')
  if (error || !reservation) throw error ?? new Error('Sandbox reservation failed.')
  let sandbox: Sandbox | undefined
  let creationStarted = false
  const name = `codetutor-${reservation}`
  try {
    checkActive()
    creationStarted = true
    sandbox = await Sandbox.create({ name, ports: [...new Set(ports)], timeout, persistent: false,
      signal: AbortSignal.any([AbortSignal.timeout(45_000), ...(signal ? [signal] : [])]), ...getSandboxCredentials() })
    checkActive()
    if (project.activity_id && isDSALanguage(project.language) && (isTrustedDSAId(project.activity_id) || hasTrustedChallengeGrader(project.activity_id, project.language))) {
      await prepareDSARuntime(sandbox.currentSession(), project.language, signal)
    } else {
      const compiler = curatedCompiler(project.activity_id, project.language)
      if (compiler) await prepareLearningCompiler(sandbox.currentSession(), compiler, signal)
    }
    checkActive()
    const { data, error: attachError } = await admin.from('sandbox_sessions').update({
      sandbox_id: sandbox.name, status: 'running', expires_at: sandbox.expiresAt?.toISOString() ?? new Date(Date.now() + timeout).toISOString(), updated_at: new Date().toISOString(),
    }).eq('id', reservation).eq('user_id', auth.user.id).eq('status', 'creating').select('id').maybeSingle()
    if (attachError || !data) throw attachError ?? new Error('The project was removed while its sandbox was starting.')
    checkActive()
    return { sandboxId: sandbox.name, status: sandbox.status }
  } catch (cause) {
    if (sandbox) await sandbox.stop({ signal: AbortSignal.timeout(5_000) }).catch(() => undefined)
    else if (creationStarted) await stopSandboxByName(name).catch(() => undefined)
    // The trigger atomically retains cleanup when this request loses the VM
    // receipt, or when the first Stop failed. No successful stop is invented.
    const failed = await admin.from('sandbox_sessions').update({ status: 'failed', updated_at: new Date().toISOString() })
      .eq('id', reservation).eq('user_id', auth.user.id)
    if (failed.error) console.warn('Sandbox failure record unconfirmed', { reservationId: reservation })
    if (!creationStarted && !failed.error) {
      // No provider request was dispatched. Only this server knows that fact;
      // clear the reservation without waiting through a visibility grace period.
      const cleared = await admin.from('sandbox_cleanup_jobs').update({ state: 'complete', outcome: 'not_started', updated_at: new Date().toISOString() })
        .eq('id', reservation).eq('user_id', auth.user.id).in('state', ['armed', 'pending'])
      if (cleared.error) console.warn('Unused sandbox reservation cleanup unconfirmed', { reservationId: reservation })
    }
    scheduleSandboxCleanup([reservation])
    checkActive()
    throw cause
  }
}

export async function getOwnedSandbox(auth: AuthContext, sandboxId: string, projectId?: string, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const session = await requireOwnedSandbox(sandboxId, auth, signal)
  if (projectId && session.project_id !== projectId) throw new ApiError(404, 'SANDBOX_NOT_FOUND', 'Sandbox not found in this project.')
  try {
    const sandbox = await Sandbox.get({ name: sandboxId, resume: false, signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]), ...getSandboxCredentials() })
    let vm
    try { vm = sandbox.currentSession() }
    catch { throw new ApiError(410, 'SANDBOX_EXPIRED', 'This sandbox expired. Restore your project to continue.') }
    if (vm.status !== 'running' && vm.status !== 'pending') throw new ApiError(410, 'SANDBOX_EXPIRED', 'This sandbox expired. Restore your project to continue.')
    return vm
  } catch (error) {
    if (isSandboxUnavailableError(error) || (error instanceof ApiError && error.status === 410)) {
      await createAdminSupabaseClient().from('sandbox_sessions').update({ status: 'expired', updated_at: new Date().toISOString() }).eq('id', session.id).eq('user_id', auth.user.id)
      throw new ApiError(410, 'SANDBOX_EXPIRED', 'This sandbox expired. Restore your project to continue.')
    }
    throw error
  }
}

export async function sandboxForRequest(request: Request, sandboxId: string, signal?: AbortSignal) {
  const auth = await requireUser(request)
  signal?.throwIfAborted()
  if (request.method !== 'GET') assertSameOrigin(request)
  const sandbox = await getOwnedSandbox(auth, sandboxId, undefined, signal)
  if (request.method !== 'GET') await consumeQuota(auth.user.id, 'sandbox-mutation')
  return sandbox
}

export async function readOwnedSandboxPreview(auth: AuthContext, sandboxId: string, projectId: string, port?: number, signal = new AbortController().signal): Promise<PreviewReceipt> {
  return readWithDeadline(async active => {
    if (!z.string().uuid().safeParse(projectId).success) throw new ApiError(400, 'INVALID_PROJECT_ID', 'Choose a valid project.')
    const session = await requireOwnedSandbox(sandboxId, auth, active)
    active.throwIfAborted()
    if (session.project_id !== projectId) throw new ApiError(404, 'SANDBOX_NOT_FOUND', 'Sandbox not found in this project.')
    const ports = [...new Set(session.ports)]
    if (!z.array(previewPortSchema).min(1).max(4).safeParse(ports).success) throw new ApiError(502, 'INVALID_PREVIEW_PORTS', 'The sandbox has no valid exposed preview ports.')
    if (port !== undefined && !ports.includes(port)) throw new ApiError(400, 'PORT_NOT_EXPOSED', 'Choose a port exposed by this sandbox.')
    const sandbox = await getOwnedSandbox(auth, sandboxId, projectId, active)
    active.throwIfAborted()
    const origins = ports.map(exposed => sandbox.domain(exposed))
    if (origins.some(origin => !previewOriginSchema.safeParse(origin).success)) throw new ApiError(502, 'INVALID_PREVIEW_ORIGIN', 'The sandbox returned an invalid preview address.')
    const index = port === undefined ? Math.max(0, origins.indexOf(session.preview_origin ?? '')) : ports.indexOf(port)
    return { projectId, sandboxId, ports, port: ports[index], url: origins[index] }
  }, signal, 20_000, 'Checking the sandbox preview timed out. Please retry.')
}

export async function connectOwnedSandboxPreview(auth: AuthContext, sandboxId: string, projectId: string, port?: number, signal = new AbortController().signal) {
  const preview = await readOwnedSandboxPreview(auth, sandboxId, projectId, port, signal)
  // Persist only an origin returned by this live, owned VM. An unconfirmed
  // receipt may still commit; callers can safely re-read the selected port.
  await awaitMutationReceipt(async active => {
    active.throwIfAborted()
    const { data, error } = await createAdminSupabaseClient().from('sandbox_sessions')
      .update({ preview_origin: preview.url, updated_at: new Date().toISOString() })
      .eq('sandbox_id', sandboxId).eq('project_id', projectId).eq('user_id', auth.user.id).eq('status', 'running')
      .abortSignal(active).select('id').maybeSingle()
    if (error) throw error
    if (!data) throw new ApiError(410, 'SANDBOX_EXPIRED', 'This sandbox is no longer running. Restore the project to continue.')
  }, signal, 5_000, 'The preview selection could not be confirmed. Reconnect to check the saved selection.')
  return preview
}

export async function getOwnedSandboxUrl(auth: AuthContext, sandboxId: string, port: number, projectId: string, signal?: AbortSignal) {
  return (await connectOwnedSandboxPreview(auth, sandboxId, projectId, port, signal)).url
}

export { requestOwnedShutdown as stopOwnedSandbox } from './sandbox-shutdown'

/** Caller must verify ownership first. Never resume a stopped VM to stop it. */
export async function stopSandboxByName(name: string) {
  const signal = AbortSignal.timeout(10_000)
  const sandbox = await Sandbox.get({ name, resume: false, signal, ...getSandboxCredentials() })
  let vm
  try { vm = sandbox.currentSession() } catch { return }
  if (vm.status === 'stopped' || vm.status === 'failed') return
  await vm.stop({ signal })
}
