import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APIError } from '@vercel/sandbox'
import { GET as logsRoute } from '@/app/api/sandboxes/[sandboxId]/cmds/[cmdId]/logs/route'
import { GET as statusRoute, DELETE as stopRoute } from '@/app/api/sandboxes/[sandboxId]/cmds/[cmdId]/route'
import { commandForRequest } from '@/lib/server/owned-command'
import { ApiError } from '@/lib/server/api'
import { COMMAND_LOG_WINDOW_BYTES, commandStreamRecordSchema } from '@/lib/commands/protocol'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/server/owned-command', () => ({ commandForRequest: vi.fn() }))
const context = { params: Promise.resolve({ sandboxId: 'owned-sandbox', cmdId: 'command-a' }) }
const request = (cursor = '-1', signal?: AbortSignal) => new Request(`http://localhost/api/logs?cursor=${cursor}`, { signal })
const records = (text: string) => text.trim().split('\n').filter(Boolean).map((line) => commandStreamRecordSchema.parse(JSON.parse(line)))

function fixture(data: string[], exitCode: number | null = 0) {
  const close = vi.fn()
  const command = {
    cmdId: 'command-a', startedAt: 123, exitCode,
    wait: vi.fn<(options: { signal: AbortSignal }) => Promise<{ exitCode: number }>>(() => new Promise(() => {})),
    logs: vi.fn((options: { signal: AbortSignal }) => Object.assign((async function* () {
      for (const value of data) { options.signal.throwIfAborted(); yield { stream: 'stdout', data: value } }
    })(), { close })),
  }
  const sandbox = { getCommand: vi.fn(async () => command) }
  const complete = vi.fn(async () => {})
  const cancel = vi.fn(async () => {})
  vi.mocked(commandForRequest).mockResolvedValue({ command, complete, cancel } as never)
  return { command, sandbox, close, complete, cancel }
}
beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks() })

it('decodes new command logs before cursor accounting across regrouped replay windows', async () => {
  const text = '\uFEFF🙂你好 café\n'.repeat(12000), bytes = Buffer.from(text)
  let encoded = '', sequence = 0
  for (let i = 0; i < bytes.length; i += 3071) encoded += `CT1:${sequence++}:${bytes.subarray(i, i + 3071).toString('base64')}\n`
  encoded += `CT1:${sequence}:.\n`
  const f = fixture([])
  let reads = 0
  f.command.logs.mockImplementation(() => Object.assign((async function* () {
    const size = ++reads % 2 ? 17 : 16384
    for (let i = 0; i < encoded.length; i += size) yield { stream: 'stdout', data: encoded.slice(i, i + size) }
  })(), { close: f.close }))
  vi.mocked(commandForRequest).mockResolvedValue({ command: f.command, complete: f.complete, cancel: f.cancel, encoding: 'base64-v1' } as never)
  let cursor = 'v3.0.0', output = '', done = false, windows = 0
  while (!done && windows++ < 20) {
    const response = await logsRoute(request(cursor), context)
    const body = await response.text()
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(COMMAND_LOG_WINDOW_BYTES)
    for (const item of records(body)) {
      if (item.type === 'log') {
        output += item.data; cursor = item.cursor
        expect(cursor).toBe(`v3.${Buffer.byteLength(output)}.0`)
      } else if (item.type === 'status') done = item.status === 'done'
      else throw new Error(item.error.code)
    }
  }
  expect(done).toBe(true); expect(windows).toBeGreaterThan(1)
  expect(output === text).toBe(true)
  expect(f.complete).toHaveBeenCalledOnce()
})

describe('bounded command log endpoints', () => {
  it('returns running status after a bounded probe without waiting for exit', async () => {
    vi.useFakeTimers()
    const f = fixture([], null)
    const pending = statusRoute(request(), context)
    await vi.advanceTimersByTimeAsync(1_000)
    const response = await pending
    expect(await response.json()).toMatchObject({ status: 'running', exitCode: null })
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(f.command.wait).toHaveBeenCalledOnce()
    expect(f.command.wait.mock.calls[0][0].signal.aborted).toBe(true)
    expect(f.command.logs).not.toHaveBeenCalled()
  })

  it('settles detached output whose SDK metadata is stale until wait is consulted', async () => {
    const f = fixture(['finished'], null)
    f.command.wait.mockResolvedValue({ exitCode: 0 })
    const output = records(await (await logsRoute(request(), context)).text())
    expect(output.at(-1)).toEqual({ type: 'status', status: 'done', exitCode: 0 })
    expect(f.command.wait).toHaveBeenCalledOnce()
  })

  it('returns the actual failure code from a completed detached command', async () => {
    const f = fixture([], null)
    f.command.wait.mockResolvedValue({ exitCode: 3 })
    expect(await (await statusRoute(request(), context)).json()).toMatchObject({ status: 'done', exitCode: 3 })
  })

  it('delivers all escaped/multibyte output across bounded reconnects without loss', async () => {
    const original = '🙂\0\n\\"'.repeat(35_000)
    const f = fixture([original, '\nlast line'])
    let cursor = 'v3.0.0'
    let output = ''
    let completed = false
    for (let window = 0; window < 30 && !completed; window++) {
      const response = await logsRoute(request(String(cursor)), context)
      const text = await response.text()
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(COMMAND_LOG_WINDOW_BYTES)
      for (const record of records(text)) {
        if (record.type === 'log') {
          const offsets = cursor.split('.').slice(1).map(Number)
          offsets[record.stream === 'stdout' ? 0 : 1] += Buffer.byteLength(record.data)
          expect(record.cursor).toBe(`v3.${offsets.join('.')}`)
          expect(record.data).not.toContain('\uFFFD')
          output += record.data
          cursor = record.cursor
        } else if (record.type === 'status') completed = record.status === 'done'
      }
    }
    expect(completed).toBe(true)
    expect(output).toBe(`${original}\nlast line`)
    expect(f.command.wait).not.toHaveBeenCalled()
    expect(f.close).toHaveBeenCalled()
  })

  it('resumes correctly when SDK transport chunks are regrouped', async () => {
    fixture(['a', 'bc🙂', 'tail'])
    const response = await logsRoute(request('v3.3.0'), context)
    const output = records(await response.text()).flatMap((record) => record.type === 'log' ? [record.data] : []).join('')
    expect(output).toBe('🙂tail')
  })

  it('resumes each stream independently when stdout/stderr are reordered on replay', async () => {
    const f = fixture([])
    f.command.logs.mockImplementation(() => Object.assign((async function* () {
      yield { stream: 'stderr', data: 'end' }
      yield { stream: 'stdout', data: '🙂\n'.repeat(20) }
    })(), { close: f.close }))
    const output = records(await (await logsRoute(request('v3.50.3'), context)).text())
    expect(output.flatMap((record) => record.type === 'log' ? [record.data] : []).join('')).toBe('🙂\n'.repeat(10))
    expect(output[0]).toMatchObject({ cursor: 'v3.100.3', stream: 'stdout' })
  })

  it('closes an idle stream at 20 seconds and aborts its SDK reader', async () => {
    vi.useFakeTimers()
    const f = fixture([], null)
    f.command.logs.mockImplementation(() => ({ next: () => new Promise(() => {}), close: f.close }) as never)
    const response = await logsRoute(request(), context)
    const text = response.text()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(records(await text)).toEqual([{ type: 'status', status: 'running', exitCode: null }])
    expect(f.command.logs.mock.calls[0][0].signal.aborted).toBe(true)
    expect(f.close).toHaveBeenCalled()
    expect(f.command.wait).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds status refresh even when logs ended before the process exited', async () => {
    vi.useFakeTimers()
    const f = fixture([], null)
    const response = await logsRoute(request(), context)
    const text = response.text()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(records(await text).at(-1)).toMatchObject({ type: 'status', status: 'running' })
    expect(f.command.wait).toHaveBeenCalledOnce()
    expect(f.close).toHaveBeenCalled()
  })

  it('bounds an unresponsive ownership/lookup read before streaming starts', async () => {
    vi.useFakeTimers()
    vi.mocked(commandForRequest).mockImplementation(() => new Promise(() => {}))
    const pending = logsRoute(request(), context)
    await vi.advanceTimersByTimeAsync(20_000)
    expect((await pending).status).toBe(408)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels an idle log connection when the browser cancels its reader', async () => {
    const f = fixture([], null)
    f.command.logs.mockImplementation(() => ({ next: () => new Promise(() => {}), close: f.close }) as never)
    const response = await logsRoute(request(), context)
    await response.body!.cancel()
    expect(f.command.logs.mock.calls[0][0].signal.aborted).toBe(true)
    expect(f.close).toHaveBeenCalled()
  })

  it('does not expose raw upstream failures inside an already-open stream', async () => {
    const f = fixture([])
    f.command.logs.mockImplementation(() => Object.assign((async function* () { throw new Error('secret token and source') })(), { close: f.close }))
    const text = await (await logsRoute(request(), context)).text()
    expect(text).not.toContain('secret token')
    expect(records(text).at(-1)).toMatchObject({ type: 'error', status: 502, error: { code: 'COMMAND_LOGS_FAILED' } })
  })

  it('represents expiration during streaming as a terminal expected event', async () => {
    const f = fixture([])
    f.command.logs.mockImplementation(() => Object.assign((async function* () { throw new APIError(new Response('', { status: 404 }), { json: { error: { code: 'not_found' } } }) })(), { close: f.close }))
    expect(records(await (await logsRoute(request(), context)).text())).toEqual([{ type: 'status', status: 'expired', exitCode: null }])
    expect(console.error).not.toHaveBeenCalled()
  })

  it.each(['1.5', '-2', 'Infinity', '9007199254740992', ''])('rejects malformed cursor %s before sandbox access', async (cursor) => {
    const response = await logsRoute(request(cursor), context)
    expect(response.status).toBe(400)
    expect(commandForRequest).not.toHaveBeenCalled()
  })

  it.each([401, 404, 410])('preserves ownership/expiry failure %i without fetching command data', async (status) => {
    const f = fixture([])
    vi.mocked(commandForRequest).mockRejectedValue(new ApiError(status, 'EXPECTED', 'Unavailable.'))
    expect((await logsRoute(request(), context)).status).toBe(status)
    expect(f.sandbox.getCommand).not.toHaveBeenCalled()
  })
})

describe('owned command Stop endpoint', () => {
  const stopRequest = (origin = 'http://localhost') => new Request('http://localhost/api/command', { method: 'DELETE', headers: { origin } })

  it('confirms cancellation after a bounded running-status probe', async () => {
    vi.useFakeTimers()
    const f = fixture([], null)
    const pending = stopRoute(stopRequest(), context)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await (await pending).json()).toMatchObject({ stopped: true })
    expect(f.cancel).toHaveBeenCalledOnce()
    expect(f.complete).not.toHaveBeenCalled()
  })

  it('acknowledges already-completed commands without issuing another kill', async () => {
    const f = fixture([], 3)
    expect((await stopRoute(stopRequest(), context)).status).toBe(200)
    expect(f.cancel).not.toHaveBeenCalled()
    expect(f.complete).toHaveBeenCalledWith(3, expect.any(AbortSignal))
  })

  it('rejects a foreign origin without an ownership or SDK lookup', async () => {
    expect((await stopRoute(stopRequest('https://other.example'), context)).status).toBe(403)
    expect(commandForRequest).not.toHaveBeenCalled()
  })

  it.each([401, 404, 410])('preserves ownership/expiration rejection %i', async (status) => {
    const f = fixture([])
    vi.mocked(commandForRequest).mockRejectedValue(new ApiError(status, 'UNAVAILABLE', 'Unavailable'))
    expect((await stopRoute(stopRequest(), context)).status).toBe(status)
    expect(f.cancel).not.toHaveBeenCalled()
  })

  it('does not report success when termination is uncertain', async () => {
    vi.useFakeTimers()
    const f = fixture([], null)
    f.cancel.mockRejectedValue(new ApiError(502, 'COMMAND_STOP_UNCERTAIN', 'Retry Stop.'))
    const pending = stopRoute(stopRequest(), context)
    await vi.advanceTimersByTimeAsync(1_000)
    const response = await pending
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: { code: 'COMMAND_STOP_UNCERTAIN' } })
  })

  it('bounds a stalled ownership lookup without issuing a late kill', async () => {
    vi.useFakeTimers()
    // Node's native AbortSignal.timeout bypasses Vitest's fake timer queue.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms)
      return controller.signal
    })
    vi.mocked(commandForRequest).mockReturnValue(new Promise(() => {}))
    const pending = stopRoute(stopRequest(), context)
    await vi.advanceTimersByTimeAsync(10_000)
    expect((await pending).status).toBe(408)
  })
})
