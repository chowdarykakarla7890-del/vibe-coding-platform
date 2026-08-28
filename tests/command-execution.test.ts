import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Command } from '@vercel/sandbox'
import { COMMAND_OUTPUT_BYTES, COMMAND_TIMEOUT_MS, captureCommandOutput } from '@/lib/server/command-execution'

vi.mock('server-only', () => ({}))
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

function fixture(lines: string[], exitCode = 0) {
  const close = vi.fn()
  const command = {
    wait: vi.fn<(options: { signal: AbortSignal }) => Promise<{ exitCode: number }>>(async () => ({ exitCode })),
    kill: vi.fn<(signal: string, options: { abortSignal: AbortSignal }) => Promise<void>>(async () => {}),
    logs: vi.fn((options: { signal: AbortSignal }) => { options.signal.throwIfAborted(); return Object.assign((async function* () {
      for (const data of lines) yield { stream: 'stdout', data }
    })(), { close }) }),
    output: vi.fn(),
  }
  const runCommand = vi.fn(async () => command)
  return { command, close, runCommand, sandbox: { runCommand } }
}

describe('bounded verification command execution', () => {
  it('limits decoded bytes, not base64 wire bytes, for AI/verification output', async () => {
    const expected = '🙂'.repeat(20000), bytes = Buffer.from(expected)
    const lines = []
    let index = 0
    for (let i = 0; i < bytes.length; i += 3071) lines.push(`CT1:${index++}:${bytes.subarray(i, i + 3071).toString('base64')}\n`)
    lines.push(`CT1:${index}:.\n`)
    const f = fixture(lines)
    const result = await captureCommandOutput(f.command as unknown as Command, undefined, 'base64-v1')
    expect(result.output).toBe('🙂'.repeat(COMMAND_OUTPUT_BYTES / 4))
    expect(result.outputTruncated).toBe(true)
    expect(f.close).toHaveBeenCalled()
  })
  it('enforces the process deadline and streams output without fetching it all', async () => {
    const f = fixture(['hello', '\nworld'], 1)
    await expect(captureCommandOutput(f.command as unknown as Command)).resolves.toEqual({ exitCode: 1, output: 'hello\nworld', outputTruncated: false })
    expect(f.command.output).not.toHaveBeenCalled()
    expect(f.close).toHaveBeenCalled()
    expect(f.command.kill).not.toHaveBeenCalled()
  })

  it('closes output at the UTF-8 byte limit without retaining the remainder', async () => {
    const f = fixture(['😀'.repeat(COMMAND_OUTPUT_BYTES), 'must not be collected'])
    const result = await captureCommandOutput(f.command as unknown as Command)
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(COMMAND_OUTPUT_BYTES)
    expect(result.output).not.toContain('\uFFFD')
    expect(result.output).not.toContain('must not')
    expect(result.outputTruncated).toBe(true)
  })

  it('does not create a process for an already cancelled submission', async () => {
    const f = fixture([])
    await expect(captureCommandOutput(f.command as unknown as Command, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.runCommand).not.toHaveBeenCalled()
  })

  it.each(['cancel', 'timeout'] as const)('stops wait/log requests for owner cleanup on %s', async (reason) => {
    vi.useFakeTimers()
    const f = fixture([])
    let waitSignal!: AbortSignal
    f.command.wait.mockImplementation(({ signal }) => {
      waitSignal = signal
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    })
    const controller = new AbortController()
    const result = expect(captureCommandOutput(f.command as unknown as Command, controller.signal)).rejects.toMatchObject({ name: reason === 'cancel' ? 'AbortError' : 'TimeoutError' })
    await vi.advanceTimersByTimeAsync(0)
    if (reason === 'cancel') controller.abort()
    else await vi.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS)
    await result
    expect(waitSignal.aborted).toBe(true)
    expect(f.close).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts the other connection if log streaming fails', async () => {
    const f = fixture([])
    let waitSignal!: AbortSignal
    f.command.wait.mockImplementation(({ signal }) => {
      waitSignal = signal
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    })
    f.command.logs.mockImplementation(() => Object.assign((async function* () { throw new Error('Log connection failed') })(), { close: f.close }))
    await expect(captureCommandOutput(f.command as unknown as Command)).rejects.toThrow('Log connection failed')
    expect(waitSignal.aborted).toBe(true)
  })
})
