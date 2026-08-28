import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sandbox } from '@vercel/sandbox'
import { createAdminSupabaseClient } from '@/lib/supabase/server'
import { captureSandboxSource, SourceCaptureError } from '@/lib/sandbox/source-capture'
import { acknowledgeSandboxCapture } from '@/lib/sandbox/source-ack'
import { readCommandExitCode } from '@/lib/server/command-status'
import { processSourceCapture, runSourceCaptureBatch } from '@/lib/server/source-capture-worker'
import { GET } from '@/app/api/internal/source-capture/route'
import { quiesceSandboxRuntime } from '@/lib/sandbox/shutdown-guard'

vi.mock('server-only', () => ({}))
vi.mock('@vercel/sandbox', () => ({ Sandbox: { get: vi.fn() } }))
vi.mock('@/ai/sandbox', () => ({ getSandboxCredentials: () => ({}), isSandboxUnavailableError: (error: unknown) => error instanceof Error && error.message === 'unavailable' }))
vi.mock('@/lib/supabase/server', () => ({ createAdminSupabaseClient: vi.fn() }))
vi.mock('@/lib/sandbox/source-capture', async (original) => ({ ...await original<typeof import('@/lib/sandbox/source-capture')>(), captureSandboxSource: vi.fn() }))
vi.mock('@/lib/sandbox/source-ack', () => ({ acknowledgeSandboxCapture: vi.fn() }))
vi.mock('@/lib/server/command-status', () => ({ readCommandExitCode: vi.fn() }))
vi.mock('@/lib/sandbox/shutdown-guard', () => ({ quiesceSandboxRuntime: vi.fn() }))

const jobId = '11111111-1111-4111-8111-111111111111'
const userId = '22222222-2222-4222-8222-222222222222'
const leaseToken = '33333333-3333-4333-8333-333333333333'
const sha = 'a'.repeat(64)
const base = { id: jobId, user_id: userId, project_id: '44444444-4444-4444-8444-444444444444',
  sandbox_session_id: '55555555-5555-4555-8555-555555555555', sandbox_id: 'owned-sandbox', sandbox_status: 'running',
  expires_at: '2099-01-01T00:00:00Z', state: 'capturing', lease_token: leaseToken,
  command_id: 'command-1', command_status: 'running', baseline: [{ path: 'main.ts', revision: 1, digest: sha }], acknowledgements: [],
}
let job: Record<string, unknown> | null
let failure: string | undefined
let settled = true
let complete = true
const acks = [{ path: 'main.ts', revision: 2, digest: sha }]
const calls: string[] = []
const rpc = vi.fn((name: string, args?: { p_action?: string }) => ({ abortSignal: vi.fn(async () => {
  calls.push(name === 'advance_sandbox_shutdown' ? `${name}:${args?.p_action}` : name)
  return { error: failure === name ? { message: 'private failure containing source' } : null,
    data: name === 'claim_source_capture' ? job : name === 'reconcile_source_capture'
      ? { acknowledgements: acks, complete, conflicted: false } : ['settle_source_capture', 'advance_sandbox_shutdown'].includes(name) ? settled : true }
}) }))
const vm = { status: 'running', getCommand: vi.fn(async () => ({ cmdId: 'command-1' })), stop: vi.fn(async () => { calls.push('stop') }) }

beforeEach(() => {
  vi.clearAllMocks(); job = { ...base }; failure = undefined; settled = true; complete = true; vm.status = 'running'; calls.length = 0
  vi.mocked(createAdminSupabaseClient).mockReturnValue({ rpc } as never)
  vi.mocked(Sandbox.get).mockResolvedValue({ currentSession: () => vm } as never)
  vi.mocked(readCommandExitCode).mockResolvedValue(0)
  vi.mocked(captureSandboxSource).mockImplementation(async () => { calls.push('scan'); return { entries: [], complete: true, totalBytes: 0, excluded: 0 } })
  vi.mocked(acknowledgeSandboxCapture).mockImplementation(async () => { calls.push('ack') })
  vi.mocked(quiesceSandboxRuntime).mockImplementation(async () => { calls.push('quiesce') })
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })
const outcome = (action: string) => expect(rpc).toHaveBeenCalledWith('settle_source_capture', { p_job_id: jobId, p_lease_token: leaseToken, p_action: action })

describe('durable final capture before sandbox shutdown', () => {
  beforeEach(() => { job = { ...base, purpose: 'shutdown', sandbox_status: 'stopping', command_id: null, command_status: 'done' } })

  it('quiesces, records terminated commands, persists source, fences, stops, then finalizes', async () => {
    expect(await processSourceCapture(jobId)).toBe('stopped')
    expect(calls).toEqual(['claim_source_capture', 'quiesce', 'advance_sandbox_shutdown:quiesced', 'scan',
      'reconcile_source_capture', 'advance_sandbox_shutdown:ready', 'stop', 'advance_sandbox_shutdown:stopped'])
    expect(acknowledgeSandboxCapture).not.toHaveBeenCalled()
    expect(vm.getCommand).not.toHaveBeenCalled()
    expect(Sandbox.get).toHaveBeenCalledWith(expect.objectContaining({ name: 'owned-sandbox', resume: false }))
  })

  it('does not scan or stop if learner processes could not be quiesced', async () => {
    vi.mocked(quiesceSandboxRuntime).mockRejectedValueOnce(new Error('unconfirmed'))
    expect(await processSourceCapture(jobId)).toBe('retry')
    expect(captureSandboxSource).not.toHaveBeenCalled()
    expect(vm.stop).not.toHaveBeenCalled()
  })

  it('keeps the VM when final source persistence fails', async () => {
    failure = 'reconcile_source_capture'
    expect(await processSourceCapture(jobId)).toBe('retry')
    expect(vm.stop).not.toHaveBeenCalled()
  })

  it('pauses incomplete source capture instead of destroying unsaved files', async () => {
    complete = false
    expect(await processSourceCapture(jobId)).toBe('incomplete')
    expect(vm.stop).not.toHaveBeenCalled()
    expect(calls.at(-1)).toBe('advance_sandbox_shutdown:incomplete')
  })

  it('resumes a saved checkpoint without recapturing or rerunning learner commands', async () => {
    job = { ...job, state: 'acknowledging', capture_complete: true, capture_terminal: true, quiesced_at: '2026-08-27T00:00:00Z' }
    expect(await processSourceCapture(jobId)).toBe('stopped')
    expect(quiesceSandboxRuntime).not.toHaveBeenCalled()
    expect(captureSandboxSource).not.toHaveBeenCalled()
    expect(vm.stop).toHaveBeenCalledOnce()
  })

  it('refuses an incomplete checkpoint even if acknowledgments exist', async () => {
    job = { ...job, state: 'acknowledging', capture_complete: false, capture_terminal: true, quiesced_at: '2026-08-27T00:00:00Z' }
    expect(await processSourceCapture(jobId)).toBe('incomplete')
    expect(vm.stop).not.toHaveBeenCalled()
  })

  it('does not stop after losing its database lease', async () => {
    settled = false
    await expect(processSourceCapture(jobId)).rejects.toThrow('settlement unconfirmed')
    expect(vm.stop).not.toHaveBeenCalled()
  })

  it('preserves the saved checkpoint on an uncertain Stop response', async () => {
    vm.stop.mockRejectedValueOnce(new DOMException('Timeout', 'TimeoutError'))
    expect(await processSourceCapture(jobId)).toBe('retry')
    expect(calls.at(-1)).toBe('advance_sandbox_shutdown:retry')
  })

  it('settles an already expired VM without restarting it or inventing a save', async () => {
    job = { ...job, sandbox_status: 'expired', expires_at: '2000-01-01T00:00:00Z' }
    expect(await processSourceCapture(jobId)).toBe('expired')
    expect(Sandbox.get).not.toHaveBeenCalled()
    expect(captureSandboxSource).not.toHaveBeenCalled()
    expect(calls.at(-1)).toBe('advance_sandbox_shutdown:expired')
  })
})

describe('durable source capture worker', () => {
  it('identifies claim failures without logging provider messages, source, or credentials', async () => {
    failure = 'claim_source_capture'
    await expect(processSourceCapture(jobId)).rejects.toThrow('Capture claim failed.')
    expect(console.warn).toHaveBeenCalledWith('Source capture failed', {
      stage: 'claim', jobId, errorCode: 'UNAVAILABLE', durationMs: expect.any(Number),
    })
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private failure')
    expect(Sandbox.get).not.toHaveBeenCalled()
  })
  it('checks completion, captures, commits, and then acknowledges in that order', async () => {
    expect(await processSourceCapture(jobId)).toBe('acknowledged')
    expect(calls).toEqual(['claim_source_capture', 'finish_command_execution', 'scan', 'reconcile_source_capture', 'ack', 'settle_source_capture'])
    expect(Sandbox.get).toHaveBeenCalledWith(expect.objectContaining({ name: 'owned-sandbox', resume: false }))
    expect(captureSandboxSource).toHaveBeenCalledWith(vm, ['main.ts'], expect.any(AbortSignal))
    expect(rpc).toHaveBeenCalledWith('reconcile_source_capture', expect.objectContaining({ p_terminal: true, p_lease_token: leaseToken }))
    expect(acknowledgeSandboxCapture).toHaveBeenCalledWith(vm, acks, expect.any(AbortSignal))
  })
  it('does nothing when another worker already leased or finished the job', async () => {
    job = null
    expect(await processSourceCapture(jobId)).toBe('idle')
    expect(Sandbox.get).not.toHaveBeenCalled()
  })
  it('keeps running captures nonfinal even if the process ends during scanning', async () => {
    vi.mocked(readCommandExitCode).mockResolvedValue(null)
    await processSourceCapture(jobId)
    expect(rpc).toHaveBeenCalledWith('reconcile_source_capture', expect.objectContaining({ p_terminal: false }))
    expect(rpc).not.toHaveBeenCalledWith('finish_command_execution', expect.anything())
  })
  it('captures uncertain launches without inventing command completion', async () => {
    job = { ...base, command_id: null, command_status: 'unknown' }
    await processSourceCapture(jobId)
    expect(vm.getCommand).not.toHaveBeenCalled()
    expect(rpc).toHaveBeenCalledWith('reconcile_source_capture', expect.objectContaining({ p_terminal: false }))
  })
  it('does not mistake a missing command record for an expired VM', async () => {
    vm.getCommand.mockRejectedValueOnce(new Error('unavailable'))
    await processSourceCapture(jobId)
    expect(captureSandboxSource).toHaveBeenCalledOnce()
    outcome('acknowledged')
  })
  it('resumes a persisted acknowledgment without recapturing or resaving', async () => {
    job = { ...base, state: 'acknowledging', acknowledgements: acks }
    await processSourceCapture(jobId)
    expect(captureSandboxSource).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalledWith('reconcile_source_capture', expect.anything())
    expect(acknowledgeSandboxCapture).toHaveBeenCalledOnce()
  })
  it.each(['SOURCE_WORKSPACE_CHANGED', 'SOURCE_SUPERSEDED', 'SOURCE_REVISION_MISMATCH'])('rescans rather than overwriting source after %s', async (code) => {
    vi.mocked(acknowledgeSandboxCapture).mockRejectedValueOnce(new SourceCaptureError(code))
    expect(await processSourceCapture(jobId)).toBe('rescan')
    outcome('rescan')
  })
  it('does not acknowledge a failed database commit or leak its raw error', async () => {
    failure = 'reconcile_source_capture'
    expect(await processSourceCapture(jobId)).toBe('retry')
    expect(acknowledgeSandboxCapture).not.toHaveBeenCalled()
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain('private failure')
  })
  it('leaves a lost ACK retryable without deleting its database checkpoint', async () => {
    vi.mocked(acknowledgeSandboxCapture).mockRejectedValueOnce(new Error('Network lost'))
    expect(await processSourceCapture(jobId)).toBe('retry')
    outcome('retry')
  })
  it('treats a pending VM as retryable, not expired', async () => {
    vm.status = 'pending'
    expect(await processSourceCapture(jobId)).toBe('retry')
    expect(captureSandboxSource).not.toHaveBeenCalled()
  })
  it('records expiry without resuming or replacing the saved source', async () => {
    job = { ...base, sandbox_status: 'expired' }
    expect(await processSourceCapture(jobId)).toBe('expired')
    expect(Sandbox.get).not.toHaveBeenCalled()
    expect(captureSandboxSource).not.toHaveBeenCalled()
  })
  it('does not claim completion when settlement loses its lease', async () => {
    settled = false
    await expect(processSourceCapture(jobId)).rejects.toThrow('settlement unconfirmed')
    expect(rpc.mock.calls.filter(([name]) => name === 'settle_source_capture')).toHaveLength(1)
  })
  it('releases a malformed claimed payload for bounded retry without touching the VM', async () => {
    job = { ...base, baseline: [{ path: '../secret', revision: 1, digest: sha }] }
    expect(await processSourceCapture(jobId)).toBe('retry')
    outcome('retry')
    expect(Sandbox.get).not.toHaveBeenCalled()
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain('../secret')
  })
  it('does not settle or use an invalid lease identity', async () => {
    job = { ...base, lease_token: 'invalid' }
    await expect(processSourceCapture(jobId)).rejects.toThrow()
    expect(rpc).not.toHaveBeenCalledWith('settle_source_capture', expect.anything())
    expect(Sandbox.get).not.toHaveBeenCalled()
  })
  it('uses an uncancelled, bounded signal to release a cancelled scan', async () => {
    const controller = new AbortController()
    vi.mocked(captureSandboxSource).mockImplementationOnce(async () => { controller.abort(); throw controller.signal.reason })
    expect(await processSourceCapture(jobId, controller.signal)).toBe('retry')
    const index = rpc.mock.calls.findIndex(([name]) => name === 'settle_source_capture')
    const signal = rpc.mock.results[index].value.abortSignal.mock.calls[0][0] as AbortSignal
    expect(signal.aborted).toBe(false)
  })
  it('drains no more than ten jobs per scheduled invocation', async () => {
    const result = await runSourceCaptureBatch()
    expect(result).toEqual({ processed: 10, failed: 0 })
    expect(rpc.mock.calls.filter(([name]) => name === 'claim_source_capture')).toHaveLength(10)
  })
})

describe('internal source worker authorization', () => {
  it.each([undefined, '', 'too-short'])('fails closed with missing or weak scheduler configuration', async (secret) => {
    vi.stubEnv('CRON_SECRET', secret)
    const response = await GET(new Request('https://example.test/api/internal/source-capture'))
    expect(response.status).toBe(503)
    expect(rpc).not.toHaveBeenCalled()
  })
  it.each(['', 'Bearer wrong', `Bearer ${'b'.repeat(48)}`])('rejects unauthenticated worker calls', async (authorization) => {
    vi.stubEnv('CRON_SECRET', 'a'.repeat(48))
    const response = await GET(new Request('https://example.test/api/internal/source-capture', { headers: { authorization } }))
    expect(response.status).toBe(401)
    expect((await response.json()).error.code).toBe('WORKER_AUTH_REQUIRED')
    expect(rpc).not.toHaveBeenCalled()
  })
  it('permits the configured scheduler and returns bounded metadata only', async () => {
    vi.stubEnv('CRON_SECRET', 'a'.repeat(48)); job = null
    const response = await GET(new Request('https://example.test/api/internal/source-capture', { headers: { authorization: `Bearer ${'a'.repeat(48)}` } }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ processed: 0, failed: 0 })
    expect(response.headers.get('cache-control')).toBe('private, no-store')
  })
})
