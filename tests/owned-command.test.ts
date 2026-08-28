import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, requireOwnedSandbox, type AuthContext } from '@/lib/server/api'
import { getOwnedSandbox } from '@/lib/server/sandbox'
import { createAdminSupabaseClient } from '@/lib/supabase/server'
import { runOwnedCommand, startOwnedCommand } from '@/lib/server/owned-command'
import { encodedCommand } from '@/lib/server/command-guard'
import { initializeSandboxRuntime, RuntimeGateError } from '@/lib/sandbox/runtime-gate'
import { scheduleSourceCapture } from '@/lib/server/source-capture-dispatch'
import { createHash } from 'node:crypto'
import { stopDSAGrading, trustedDSACommand } from '@/lib/sandbox/dsa-invocation'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/server/api', async (original) => ({ ...await original<typeof import('@/lib/server/api')>(), requireOwnedSandbox: vi.fn() }))
vi.mock('@/lib/server/sandbox', () => ({ getOwnedSandbox: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createAdminSupabaseClient: vi.fn() }))
vi.mock('@/lib/server/source-capture-dispatch', () => ({ scheduleSourceCapture: vi.fn() }))
vi.mock('@/lib/sandbox/runtime-gate', async (original) => ({ ...await original<typeof import('@/lib/sandbox/runtime-gate')>(), initializeSandboxRuntime: vi.fn() }))
vi.mock('@/lib/sandbox/dsa-invocation', async (original) => ({ ...await original<typeof import('@/lib/sandbox/dsa-invocation')>(), stopDSAGrading: vi.fn() }))

const userId = '11111111-1111-4111-8111-111111111111'
const reservationId = '22222222-2222-4222-8222-222222222222'
const options = { origin: 'terminal' as const, requestId: '33333333-3333-4333-8333-333333333333', projectId: 'project-a' }
const calls: string[] = []
let reserved: unknown
let attach = true
const rpc = vi.fn((name: string) => ({ abortSignal: vi.fn(async () => {
  calls.push(name)
  return { error: null, data: name === 'reserve_command_execution' ? reserved : name === 'attach_encoded_command' ? attach : true }
}) }))
const query = { select: vi.fn(), eq: vi.fn(), in: vi.fn(), not: vi.fn(), limit: vi.fn(), abortSignal: vi.fn(async () => ({ data: [], error: null })) }
const auth = { user: { id: userId }, supabase: { from: vi.fn(() => query) } } as unknown as AuthContext
const command = {
  cmdId: 'command-a', exitCode: null,
  kill: vi.fn(async () => {}), wait: vi.fn(async () => ({ exitCode: 0 })),
  logs: vi.fn(() => Object.assign((async function* () { yield { stream: 'stdout', data: 'CT1:0:b2s=\nCT1:1:.\n' } })(), { close: vi.fn() })),
}
const vm = { runCommand: vi.fn(async () => { calls.push('dispatch'); return command }), getCommand: vi.fn(), writeFiles: vi.fn(async () => { calls.push('payload') }) }

beforeEach(() => {
  vi.clearAllMocks(); calls.length = 0; attach = true
  reserved = { id: reservationId, timeout_ms: 60_000, remaining: 29, reset_at: new Date(Date.now()+60_000).toISOString() }
  for (const key of ['select','eq','in','not','limit'] as const) query[key].mockReturnValue(query)
  vi.mocked(requireOwnedSandbox).mockResolvedValue({ id: 'session-a', project_id: 'project-a' } as never)
  vi.mocked(getOwnedSandbox).mockResolvedValue(vm as never)
  vi.mocked(createAdminSupabaseClient).mockReturnValue({ rpc } as never)
})
afterEach(() => vi.restoreAllMocks())

describe('owned command execution boundary', () => {
  it('stops the registered grading supervisor before confirming command completion', async () => {
    const payload = '{}', path = `/tmp/.codetutor-grade-${options.requestId}.json`, digest = createHash('sha256').update(payload).digest('hex')
    const execution = await startOwnedCommand(auth, 'sandbox-a', { executable: 'python3' }, { ...options, origin: 'verification', trustedAssessment: { path, payload, digest } })
    await execution.cancel()
    expect(stopDSAGrading).toHaveBeenCalledWith(vm, path, expect.any(AbortSignal))
    expect(command.kill).not.toHaveBeenCalled()
    expect(command.wait).toHaveBeenCalled()
    expect(rpc).toHaveBeenCalledWith('finish_command_execution', expect.objectContaining({ p_status: 'cancelled' }))
  })

  it('keeps a grading slot reserved if neither privileged stop nor completion is confirmed', async () => {
    const payload = '{}', path = `/tmp/.codetutor-grade-${options.requestId}.json`, digest = createHash('sha256').update(payload).digest('hex')
    const execution = await startOwnedCommand(auth, 'sandbox-a', { executable: 'python3' }, { ...options, origin: 'verification', trustedAssessment: { path, payload, digest } })
    vi.mocked(stopDSAGrading).mockRejectedValueOnce(new Error('Unconfirmed stop'))
    command.wait.mockRejectedValueOnce(new Error('Unconfirmed completion'))
    await expect(execution.cancel()).rejects.toMatchObject({ code: 'COMMAND_STOP_UNCERTAIN' })
    expect(rpc).toHaveBeenCalledWith('finish_command_execution', expect.objectContaining({ p_status: 'unknown' }))
    expect(rpc).not.toHaveBeenCalledWith('finish_command_execution', expect.objectContaining({ p_status: 'cancelled' }))
  })
  it('reserves ownership/quota before staging the fixed privileged grader', async () => {
    const payload = '{}', path = `/tmp/.codetutor-grade-${options.requestId}.json`, digest = createHash('sha256').update(payload).digest('hex')
    await startOwnedCommand(auth, 'sandbox-a', { executable: 'python3' }, { ...options, origin: 'verification', trustedAssessment: { path, payload, digest } })
    expect(calls.indexOf('reserve_command_execution')).toBeLessThan(calls.indexOf('payload'))
    expect(calls.indexOf('payload')).toBeLessThan(calls.indexOf('dispatch'))
    expect(vm.runCommand).toHaveBeenCalledWith(expect.objectContaining(trustedDSACommand(path, digest)))
  })
  it.each([true, false])('requires a grader cleanup receipt after process exit (retry succeeds: %s)', async succeeds => {
    const payload = '{}', path = `/tmp/.codetutor-grade-${options.requestId}.json`, digest = createHash('sha256').update(payload).digest('hex')
    const execution = await startOwnedCommand(auth, 'sandbox-a', { executable: 'python3' }, { ...options, origin: 'verification', trustedAssessment: { path, payload, digest } })
    vi.mocked(stopDSAGrading).mockRejectedValueOnce(new Error('Cleanup unconfirmed'))
    if (!succeeds) vi.mocked(stopDSAGrading).mockRejectedValueOnce(new Error('Cleanup still unconfirmed'))
    if (succeeds) await execution.cancel()
    else await expect(execution.cancel()).rejects.toMatchObject({ code: 'COMMAND_STOP_UNCERTAIN' })
    expect(stopDSAGrading).toHaveBeenCalledTimes(2)
    expect(command.wait).toHaveBeenCalled()
    expect(rpc).toHaveBeenCalledWith('finish_command_execution', expect.objectContaining({ p_status: succeeds ? 'cancelled' : 'unknown' }))
  })
  it('does not permit a terminal or arbitrary executable to use the privileged grading branch', async () => {
    const payload = '{}', trustedAssessment = { payload, path: '/tmp/.codetutor-grade-550e8400-e29b-41d4-a716-446655440000.json', digest: createHash('sha256').update(payload).digest('hex') }
    await expect(startOwnedCommand(auth, 'sandbox-a', { executable: 'python3' }, { ...options, trustedAssessment })).rejects.toMatchObject({ code: 'INVALID_GRADING_INVOCATION' })
    await expect(startOwnedCommand(auth, 'sandbox-a', { executable: 'sh', args: ['-c','private'] }, { ...options, origin: 'verification', trustedAssessment })).rejects.toMatchObject({ code: 'INVALID_GRADING_INVOCATION' })
    await expect(startOwnedCommand(auth, 'sandbox-a', { executable: 'python3', trustedAssessment } as never, { ...options, origin: 'verification' })).rejects.toMatchObject({ code: 'INVALID_COMMAND' })
    expect(rpc).not.toHaveBeenCalled()
    expect(vm.writeFiles).not.toHaveBeenCalled()
    expect(vm.runCommand).not.toHaveBeenCalled()
  })
  it('binds the cleanup payload ID to the audited request before reserving resources', async () => {
    const payload = '{}', path = '/tmp/.codetutor-grade-550e8400-e29b-41d4-a716-446655440000.json', digest = createHash('sha256').update(payload).digest('hex')
    await expect(startOwnedCommand(auth, 'sandbox-a', { executable: 'python3' }, { ...options, origin: 'verification', trustedAssessment: { path, payload, digest } }))
      .rejects.toMatchObject({ code: 'INVALID_GRADING_INVOCATION' })
    expect(rpc).not.toHaveBeenCalled()
    expect(vm.writeFiles).not.toHaveBeenCalled()
  })
  it.each(['upload', 'dispatch'])('cleans and fences an unacknowledged grading %s without inventing command completion', async phase => {
    const payload = '{}', path = `/tmp/.codetutor-grade-${options.requestId}.json`, digest = createHash('sha256').update(payload).digest('hex')
    if (phase === 'upload') vm.writeFiles.mockRejectedValueOnce(new Error('Upload acknowledgement lost'))
    else vm.runCommand.mockRejectedValueOnce(new Error('Dispatch acknowledgement lost'))
    await expect(startOwnedCommand(auth, 'sandbox-a', { executable: 'python3' }, { ...options, origin: 'verification', trustedAssessment: { path, payload, digest } })).rejects.toThrow()
    expect(stopDSAGrading).toHaveBeenCalledWith(vm, path, expect.any(AbortSignal))
    expect(rpc).toHaveBeenCalledWith('finish_command_execution', expect.objectContaining({ p_status: phase === 'upload' ? 'cancelled' : 'unknown' }))
  })
  it('reserves before dispatch and attaches before exposing a command', async () => {
    const result = await startOwnedCommand(auth, 'sandbox-a', { executable: 'node', args: ['secret-source-value'] }, options)
    expect(calls).toEqual(['reserve_command_execution','dispatch','attach_encoded_command'])
    expect(result.command.cmdId).toBe('command-a')
    expect(scheduleSourceCapture).toHaveBeenCalledWith(reservationId)
    expect(result.headers['X-RateLimit-Remaining']).toBe('29')
    expect(vm.runCommand).toHaveBeenCalledWith(expect.objectContaining({ detached: true, sudo: false, timeoutMs: 60_000 }))
    expect(vm.runCommand).toHaveBeenCalledWith(expect.objectContaining(encodedCommand('node', ['secret-source-value'])))
    expect(initializeSandboxRuntime).toHaveBeenCalledWith(vm, expect.any(AbortSignal))
    expect(JSON.stringify(rpc.mock.calls)).not.toContain('secret-source-value')
  })

  it('does not record arbitrary executable paths in audit metadata', async () => {
    await startOwnedCommand(auth, 'sandbox-a', { executable: '/path/private-secret/tool' }, options)
    expect(rpc).toHaveBeenCalledWith('reserve_command_execution', expect.objectContaining({ p_executable: 'custom' }))
    expect(JSON.stringify(rpc.mock.calls)).not.toContain('private-secret')
  })

  it.each(['COMMAND_CONCURRENCY_LIMIT','COMMAND_RATE_LIMIT'])('does not start a process when %s is exhausted', async (code) => {
    reserved = { code }
    await expect(startOwnedCommand(auth, 'sandbox-a', { executable: 'node' }, options)).rejects.toMatchObject({ status: 429, code })
    expect(vm.runCommand).not.toHaveBeenCalled()
    expect(scheduleSourceCapture).not.toHaveBeenCalled()
  })

  it('rejects a cross-project sandbox before reserving or executing', async () => {
    await expect(startOwnedCommand(auth, 'sandbox-a', { executable: 'node' }, { ...options, projectId: 'project-b' })).rejects.toMatchObject({ status: 404 })
    expect(rpc).not.toHaveBeenCalled()
    expect(vm.runCommand).not.toHaveBeenCalled()
  })

  it('rejects unavailable sandbox ownership before execution', async () => {
    vi.mocked(requireOwnedSandbox).mockRejectedValueOnce(new ApiError(410, 'SANDBOX_EXPIRED', 'Expired'))
    await expect(startOwnedCommand(auth, 'sandbox-a', { executable: 'node' }, options)).rejects.toMatchObject({ status: 410 })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('keeps an uncertain launch reserved instead of releasing another slot', async () => {
    vm.runCommand.mockRejectedValueOnce(new TypeError('Network lost after dispatch'))
    await expect(startOwnedCommand(auth, 'sandbox-a', { executable: 'node' }, options)).rejects.toMatchObject({ code: 'COMMAND_START_UNCERTAIN' })
    expect(rpc).toHaveBeenCalledWith('finish_command_execution', expect.objectContaining({ p_status: 'unknown' }))
    expect(vm.runCommand).toHaveBeenCalledOnce()
  })

  it('kills an acknowledged process when attaching its reservation fails', async () => {
    attach = false
    await expect(startOwnedCommand(auth, 'sandbox-a', { executable: 'node' }, options)).rejects.toThrow('attachment failed')
    expect(command.kill).toHaveBeenCalledWith('SIGKILL', expect.anything())
    expect(rpc).toHaveBeenCalledWith('finish_command_execution', expect.objectContaining({ p_status: 'cancelled' }))
  })

  it('retains the slot when process cleanup cannot be confirmed', async () => {
    attach = false
    command.kill.mockRejectedValueOnce(new Error('Unavailable'))
    command.wait.mockRejectedValueOnce(new Error('Completion also unavailable'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(startOwnedCommand(auth, 'sandbox-a', { executable: 'node' }, options)).rejects.toThrow('attachment failed')
    expect(rpc).toHaveBeenCalledWith('finish_command_execution', expect.objectContaining({ p_status: 'unknown' }))
    expect(rpc).not.toHaveBeenCalledWith('finish_command_execution', expect.objectContaining({ p_status: 'cancelled' }))
  })

  it('does not dispatch an already cancelled request', async () => {
    await expect(startOwnedCommand(auth, 'sandbox-a', { executable: 'node' }, { ...options, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' })
    expect(rpc).not.toHaveBeenCalled()
  })

  it.each(['SANDBOX_CLOSING', 'RUNTIME_GATE_UNAVAILABLE'] as const)('never launches learner code when the gate reports %s', async (code) => {
    vi.mocked(initializeSandboxRuntime).mockRejectedValueOnce(new RuntimeGateError(code))
    await expect(startOwnedCommand(auth, 'sandbox-a', { executable: 'node' }, options)).rejects.toMatchObject({ code })
    expect(vm.runCommand).not.toHaveBeenCalled()
    expect(rpc).toHaveBeenCalledWith('finish_command_execution', expect.objectContaining({ p_status: 'cancelled' }))
    expect(rpc).not.toHaveBeenCalledWith('finish_command_execution', expect.objectContaining({ p_status: 'unknown' }))
  })

  it('accepts confirmed completion if the kill acknowledgement is lost', async () => {
    const result = await startOwnedCommand(auth, 'sandbox-a', { executable: 'node' }, options)
    command.kill.mockRejectedValueOnce(new Error('Already exited'))
    command.wait.mockResolvedValueOnce({ exitCode: 0 })
    await result.cancel()
    expect(rpc).toHaveBeenCalledWith('finish_command_execution', expect.objectContaining({ p_status: 'cancelled' }))
    expect(rpc).not.toHaveBeenCalledWith('finish_command_execution', expect.objectContaining({ p_status: 'unknown' }))
  })

  it('records completion only after the foreground result is available', async () => {
    const result = await runOwnedCommand(auth, 'sandbox-a', { executable: 'node' }, { ...options, origin: 'verification' })
    expect(result).toMatchObject({ commandId: 'command-a', exitCode: 0, output: 'ok' })
    expect(rpc).toHaveBeenCalledWith('finish_command_execution', expect.objectContaining({ p_status: 'done', p_exit_code: 0 }))
  })
})
