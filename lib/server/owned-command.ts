import 'server-only'
import type { Command } from '@vercel/sandbox'
import { z } from 'zod'
import { ApiError, requireOwnedSandbox, requireUser, type AuthContext } from './api'
import { getOwnedSandbox } from './sandbox'
import { createAdminSupabaseClient } from '@/lib/supabase/server'
import { readCommandExitCode } from './command-status'
import { abortableRead } from '@/lib/abortable-read'
import { captureCommandOutput } from './command-execution'
import { encodedCommand } from './command-guard'
import { initializeSandboxRuntime, RuntimeGateError } from '@/lib/sandbox/runtime-gate'
import { scheduleSourceCapture } from './source-capture-dispatch'
import { stopDSAGrading, trustedDSACommand } from '@/lib/sandbox/dsa-invocation'
import { createHash } from 'node:crypto'

export const commandInputSchema = z.object({
  executable: z.string().min(1).max(128).refine((value) => !/[\0\r\n]/.test(value)),
  args: z.array(z.string().max(4096).refine((value) => !value.includes('\0'))).max(32).default([]),
  background: z.boolean().default(false),
}).strict()
type CommandInput = z.input<typeof commandInputSchema>
type CommandOptions = { origin: 'terminal' | 'ai' | 'verification'; requestId: string; projectId?: string; signal?: AbortSignal;
  /** Server-only data for the fixed grader. Never accepted by commandInputSchema. */
  trustedAssessment?: { path: string; payload: string; digest: string } }
type Outcome = 'done' | 'failed' | 'cancelled' | 'expired' | 'unknown'
const active = ['starting', 'running', 'unknown']
const reservationSchema = z.object({ id: z.string().uuid(), timeout_ms: z.number().int().min(1000).max(2_700_000), remaining: z.number().int(), reset_at: z.string() })
const executableCategories = new Set(['sh','bash','node','python','python3','npm','pnpm','npx','yarn','bun','deno','java','javac','go','cargo','rustc','gcc','g++','git','ls','cat','mkdir','touch','cp','mv','rm','find','grep','sed','awk','curl','wget','make','cmake','test','echo','printf','sleep'])
// Arbitrary executable strings (including paths) can themselves contain secrets.
function category(executable: string) { return executableCategories.has(executable) ? executable : 'custom' }

async function stopConfirmedCommand(command: Command, finish: (status: Outcome, exitCode?: number | null) => Promise<void>, stop?: (signal: AbortSignal) => Promise<void>) {
  try {
    const cleanup = AbortSignal.timeout(stop ? 10_000 : 5_000)
    let stopConfirmed = false
    try { await abortableRead(() => stop ? stop(cleanup) : command.kill('SIGKILL', { abortSignal: cleanup }), cleanup); stopConfirmed = true }
    catch { cleanup.throwIfAborted() }
    // The process may exit between its status probe and kill, or the kill
    // acknowledgement may be lost. A successful wait still proves completion.
    const ended = await abortableRead(() => command.wait({ signal: cleanup }), cleanup)
    // A process exit proves termination, not private grader artifact cleanup.
    // Retry a lost/failed custom receipt before reporting a completed Stop.
    if (stop && !stopConfirmed) await abortableRead(() => stop(cleanup), cleanup)
    await finish('cancelled', ended.exitCode)
  } catch {
    await finish('unknown')
    throw new ApiError(502, 'COMMAND_STOP_UNCERTAIN', stop
      ? 'Command termination or grading cleanup could not be confirmed. Retry Stop or stop the sandbox.'
      : 'Command termination could not be confirmed. Its slot remains reserved; retry Stop or stop the sandbox.')
  }
}

export async function finishCommand(userId: string, id: string, status: Outcome, exitCode: number | null = null, signal?: AbortSignal) {
  const { error } = await createAdminSupabaseClient().rpc('finish_command_execution', {
    p_user_id: userId, p_reservation_id: id, p_status: status, p_exit_code: exitCode ?? undefined,
  }).abortSignal(AbortSignal.any([AbortSignal.timeout(5_000), ...(signal ? [signal] : [])]))
  if (error) throw error
}

/** At most three candidates. Reclaim only confirmed completion/VM expiry, not
 * an elapsed HTTP timeout. This also works when no browser log reader is open. */
async function reconcileCommands(auth: AuthContext, signal: AbortSignal) {
  const { data, error } = await auth.supabase.from('command_audits')
    .select('id,command_id,sandbox_sessions!command_audits_sandbox_session_id_user_id_fkey(sandbox_id)')
    .eq('user_id', auth.user.id).in('status', active).not('command_id', 'is', null).limit(3).abortSignal(signal)
  if (error) throw error
  await Promise.all((data ?? []).map(async (row) => {
    if (!row.command_id || !row.sandbox_sessions?.sandbox_id) return
    try {
      const vm = await getOwnedSandbox(auth, row.sandbox_sessions.sandbox_id, undefined, signal)
      const command = await abortableRead(() => vm.getCommand(row.command_id!, { signal }), signal)
      const exitCode = await readCommandExitCode(command, signal)
      if (exitCode !== null) await finishCommand(auth.user.id, row.id, 'done', exitCode)
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof ApiError && error.status === 410) await finishCommand(auth.user.id, row.id, 'expired')
      // Unknown upstream states keep their slot. Fail closed, not open.
    }
  }))
}

export async function startOwnedCommand(auth: AuthContext, sandboxId: string, input: CommandInput, options: CommandOptions) {
  const parsed = commandInputSchema.safeParse(input)
  if (!parsed.success || (options.origin === 'verification' && parsed.data.background)) throw new ApiError(400, 'INVALID_COMMAND', 'Choose a valid command and execution mode.')
  const body = parsed.data
  const assessment = options.trustedAssessment
  if (assessment && (options.origin !== 'verification' || body.background || body.executable !== 'python3' || body.args.length !== 0 ||
    assessment.path !== `/tmp/.codetutor-grade-${options.requestId}.json` ||
    !/^\/tmp\/\.codetutor-grade-[a-f0-9-]{36}\.json$/.test(assessment.path) || Buffer.byteLength(assessment.payload) > 2 * 1024 * 1024 ||
    createHash('sha256').update(assessment.payload).digest('hex') !== assessment.digest)) {
    throw new ApiError(400, 'INVALID_GRADING_INVOCATION', 'Use the registered server grading protocol.')
  }
  const signal = AbortSignal.any([AbortSignal.timeout(25_000), ...(options.signal ? [options.signal] : [])])
  signal.throwIfAborted()
  const session = await requireOwnedSandbox(sandboxId, auth, signal)
  if (options.projectId && session.project_id !== options.projectId) throw new ApiError(404, 'SANDBOX_NOT_FOUND', 'Sandbox not found in this project.')
  const vm = await getOwnedSandbox(auth, sandboxId, session.project_id, signal)
  await reconcileCommands(auth, signal)
  signal.throwIfAborted()
  const admin = createAdminSupabaseClient()
  const { data, error } = await admin.rpc('reserve_command_execution', {
    p_user_id: auth.user.id, p_session_id: session.id, p_request_id: options.requestId,
    p_executable: category(body.executable), p_origin: options.origin, p_background: body.background,
  }).abortSignal(signal)
  if (error?.message === 'SOURCE_REVIEW_REQUIRED') throw new ApiError(409, 'SOURCE_REVIEW_REQUIRED', 'Review and export unresolved source conflicts before running more commands.')
  if (error) throw error
  if (data && typeof data === 'object' && !Array.isArray(data) && typeof data.code === 'string') {
    const messages: Record<string, [number, string]> = {
      SANDBOX_NOT_FOUND: [404, 'Sandbox not found.'], SANDBOX_EXPIRED: [410, 'This sandbox expired. Restore your project.'],
      COMMAND_ALREADY_RESERVED: [409, 'This command request has already been submitted.'],
      COMMAND_CONCURRENCY_LIMIT: [429, 'Three commands are already active. Stop one or wait for it to finish.'],
      COMMAND_RATE_LIMIT: [429, 'You can start 30 commands per minute. Please wait and retry.'],
    }
    const [status, message] = messages[data.code] ?? [502, 'Command reservation failed.']
    const retry = data.code === 'COMMAND_RATE_LIMIT' && typeof data.reset_at === 'string' ? Math.max(1, Math.ceil((Date.parse(data.reset_at) - Date.now()) / 1000)) : 2
    throw new ApiError(status, data.code, message, status === 429 ? { 'Retry-After': String(retry), 'X-RateLimit-Limit': '30', 'X-RateLimit-Remaining': '0' } : undefined)
  }
  const reservation = reservationSchema.parse(data)
  // The reservation transaction already committed its capture job and source
  // baseline. Schedule before dispatch so uncertain launches are covered too.
  scheduleSourceCapture(reservation.id)
  let command: Command | undefined
  let dispatched = false
  let assessmentStaged = false
  const finish = (status: Outcome, exitCode: number | null = null) => finishCommand(auth.user.id, reservation.id, status, exitCode)
  const cancel = async () => {
    if (!command) {
      if (assessment && assessmentStaged) {
        try { await abortableRead(() => stopDSAGrading(vm, assessment.path, AbortSignal.timeout(5000)), AbortSignal.timeout(6000)) }
        catch {
          await finish('unknown')
          throw new ApiError(502, 'COMMAND_STOP_UNCERTAIN', 'Grading cleanup could not be confirmed. Retry Stop or stop the sandbox.')
        }
      }
      return finish(dispatched ? 'unknown' : 'cancelled')
    }
    return stopConfirmedCommand(command, finish, assessment ? (signal) => stopDSAGrading(vm, assessment.path, signal) : undefined)
  }
  try {
    signal.throwIfAborted()
    try { await initializeSandboxRuntime(vm, signal) }
    catch (error) {
      if (error instanceof RuntimeGateError) throw new ApiError(error.code === 'SANDBOX_CLOSING' ? 409 : 502, error.code,
        error.code === 'SANDBOX_CLOSING' ? 'This sandbox is closing. Finish recovery before running another command.' : 'The command safety guard could not be prepared. Retry without clearing saved work.')
      throw error
    }
    signal.throwIfAborted()
    if (assessment) {
      assessmentStaged = true
      await vm.writeFiles([{ path: assessment.path, content: assessment.payload }], { signal })
    }
    dispatched = true
    // The checked-in SDK patch disables automatic retries for this POST.
    // Kernel-enforced process-tree cleanup and privilege restriction.
    // Privilege is granted ONLY to fixed, reviewed supervisors. Source is
    // digest-verified data; the grader drops privileges before compilation or
    // execution. No caller/model-supplied executable is interpolated here.
    const invocation = assessment ? trustedDSACommand(assessment.path, assessment.digest) : encodedCommand(body.executable, body.args)
    command = await vm.runCommand({ ...invocation, detached: true,
      timeoutMs: reservation.timeout_ms, signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) })
    signal.throwIfAborted()
    const attached = await admin.rpc('attach_encoded_command', { p_user_id: auth.user.id, p_reservation_id: reservation.id, p_command_id: command.cmdId }).abortSignal(signal)
    if (attached.error || !attached.data) throw new Error('Command reservation attachment failed.')
    signal.throwIfAborted()
    return { command, finish, cancel, headers: {
      'X-RateLimit-Limit': '30', 'X-RateLimit-Remaining': String(reservation.remaining),
      'X-RateLimit-Reset': String(Math.ceil(Date.parse(reservation.reset_at) / 1000)),
    } }
  } catch (error) {
    await cancel().catch(() => { console.error('Command cleanup needs reconciliation', { requestId: options.requestId, reservationId: reservation.id }) })
    if (!command && dispatched) throw new ApiError(502, 'COMMAND_START_UNCERTAIN', 'The command start could not be confirmed. Its slot is reserved for safety. Stop the sandbox if it does not recover.')
    throw error
  }
}

export async function runOwnedCommand(auth: AuthContext, sandboxId: string, input: CommandInput, options: CommandOptions, onStarted?: (command: Command) => void) {
  const execution = await startOwnedCommand(auth, sandboxId, { ...input, background: false }, options)
  try {
    onStarted?.(execution.command)
    const result = await captureCommandOutput(execution.command, options.signal, 'base64-v1')
    await execution.finish('done', result.exitCode)
    return { ...result, commandId: execution.command.cmdId }
  } catch (error) {
    await execution.cancel().catch(() => { console.error('Command cleanup needs reconciliation', { requestId: options.requestId }) })
    throw error
  }
}

/** No client/model command ID is trusted before the owned audit lookup. */
export async function commandForRequest(request: Request, sandboxId: string, commandId: string, signal: AbortSignal) {
  const auth = await requireUser(request)
  const session = await requireOwnedSandbox(sandboxId, auth, signal)
  const { data, error } = await auth.supabase.from('command_audits').select('id,output_encoding,origin,request_id')
    .eq('user_id', auth.user.id).eq('sandbox_session_id', session.id).eq('command_id', commandId).abortSignal(signal).maybeSingle()
  if (error) throw error
  if (!data) throw new ApiError(404, 'COMMAND_NOT_FOUND', 'Command not found in this sandbox.')
  scheduleSourceCapture(data.id)
  const vm = await getOwnedSandbox(auth, sandboxId, session.project_id, signal)
  const command = await abortableRead(() => vm.getCommand(commandId, { signal }), signal)
  return {
    command,
    encoding: z.enum(['raw', 'base64-v1']).parse(data.output_encoding),
    complete: (exitCode: number, signal?: AbortSignal) => finishCommand(auth.user.id, data.id, 'done', exitCode, signal),
    cancel: () => stopConfirmedCommand(command, (status, exitCode) => finishCommand(auth.user.id, data.id, status, exitCode),
      data.origin === 'verification' ? (signal) => stopDSAGrading(vm, `/tmp/.codetutor-grade-${data.request_id}.json`, signal) : undefined),
  }
}
