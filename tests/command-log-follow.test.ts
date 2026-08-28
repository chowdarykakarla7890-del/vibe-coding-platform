import { afterEach, describe, expect, it, vi } from 'vitest'
import { followCommandLogs } from '@/lib/commands/follow-logs'
import { streamCommandLogs, CommandOutputError } from '@/components/commands-logs/api'
import { appendCommandLog, MAX_RETAINED_LOG_BYTES, MAX_RETAINED_LOG_RECORDS } from '@/lib/commands/log-state'
import type { Command } from '@/components/commands-logs/types'

vi.mock('@/components/commands-logs/api', async (original) => ({ ...await original<object>(), streamCommandLogs: vi.fn() }))
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks() })
const log = (cursor: number) => ({ type: 'log' as const, cursor: `v3.${cursor}.0`, data: 'text', stream: 'stdout' as const, timestamp: 123 })
const done = { type: 'status' as const, status: 'done' as const, exitCode: 0 }
const run = (controller = new AbortController(), onRecord = vi.fn()) => followCommandLogs({ sandboxId: 'sandbox', cmdId: 'cmd', signal: controller.signal, onRecord })

describe('command output reconnection', () => {
  it('retries a transient partial stream from its last delivered cursor, without duplicates', async () => {
    vi.useFakeTimers()
    vi.mocked(streamCommandLogs).mockImplementationOnce(async function* () { yield log(9); throw new TypeError('Network disconnected') })
      .mockImplementationOnce(async function* () { yield log(9); yield log(19); yield done })
    const onRecord = vi.fn()
    const pending = run(undefined, onRecord)
    await vi.advanceTimersByTimeAsync(500)
    await pending
    expect(vi.mocked(streamCommandLogs).mock.calls.map((call) => call[2])).toEqual(['v3.0.0', 'v3.9.0'])
    expect(onRecord.mock.calls.map(([record]) => record)).toEqual([log(9), log(19), done])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops after three backoff retries rather than looping indefinitely', async () => {
    vi.useFakeTimers()
    vi.mocked(streamCommandLogs).mockImplementation(async function* () { throw new TypeError('Network disconnected') })
    const pending = expect(run()).rejects.toBeInstanceOf(TypeError)
    await vi.advanceTimersByTimeAsync(10_000)
    await pending
    expect(streamCommandLogs).toHaveBeenCalledTimes(4)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([400, 401, 403, 404, 410])('never retries a terminal %i response', async (status) => {
    vi.mocked(streamCommandLogs).mockImplementation(async function* () { throw new CommandOutputError('Unavailable', 'EXPECTED', status) })
    await expect(run()).rejects.toMatchObject({ status })
    expect(streamCommandLogs).toHaveBeenCalledOnce()
  })

  it('cancels pending retry timers on project switch/unmount', async () => {
    vi.useFakeTimers()
    vi.mocked(streamCommandLogs).mockImplementation(async function* () { throw new TypeError('Network disconnected') })
    const controller = new AbortController()
    const pending = run(controller)
    await vi.advanceTimersByTimeAsync(1)
    controller.abort()
    await pending
    expect(streamCommandLogs).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('bounded terminal state', () => {
  const command: Command = { cmdId: 'cmd', sandboxId: 'sandbox', startedAt: 1, command: 'node', args: [] }
  it('ignores replayed cursors, including across subscriber remounts', () => {
    const value = appendCommandLog(command, log(9), 'v3.9.0')
    expect(appendCommandLog(value, log(9), 'v3.9.0')).toBe(value)
    expect(value.logCursor).toBe('v3.9.0')
  })
  it('bounds retained text without splitting multibyte characters', () => {
    const value = appendCommandLog(command, { ...log(1), data: '🙂'.repeat(MAX_RETAINED_LOG_BYTES) }, 'v3.1.0')
    expect(Buffer.byteLength(value.logs![0].data)).toBeLessThanOrEqual(MAX_RETAINED_LOG_BYTES)
    expect(value.logs![0].data).not.toContain('\uFFFD')
    expect(value.logsTruncated).toBe(true)
  })
  it('bounds even a flood of empty/tiny records', () => {
    let value = command
    for (let cursor = 1; cursor <= MAX_RETAINED_LOG_RECORDS + 20; cursor++) value = appendCommandLog(value, log(cursor), `v3.${cursor}.0`)
    expect(value.logs).toHaveLength(MAX_RETAINED_LOG_RECORDS)
    expect(value.logCursor).toBe(`v3.${MAX_RETAINED_LOG_RECORDS + 20}.0`)
    expect(value.logsTruncated).toBe(true)
  })
})
