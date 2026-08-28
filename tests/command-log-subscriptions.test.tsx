// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandLogsStream } from '@/components/commands-logs/commands-logs-stream'
import { useSandboxStore } from '@/app/state'
import { followCommandLogs } from '@/lib/commands/follow-logs'

vi.mock('@/lib/commands/follow-logs', () => ({ followCommandLogs: vi.fn() }))
beforeEach(() => {
  useSandboxStore.getState().clearSandbox()
  useSandboxStore.getState().setSandboxId('sandbox-a')
  vi.mocked(followCommandLogs).mockImplementation(({ signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })))
})
afterEach(() => { cleanup(); useSandboxStore.getState().clearSandbox(); vi.resetAllMocks() })
const add = (cmdId: string, status: 'running' | 'done' = 'running') => useSandboxStore.getState().upsertCommand({ sandboxId: 'sandbox-a', cmdId, command: 'node', args: [], status })

describe('command log subscription ownership', () => {
  it('disconnects log readers during shutdown without deleting received output', async () => {
    add('cmd-a')
    render(<CommandLogsStream />)
    const subscription = vi.mocked(followCommandLogs).mock.calls[0][0]
    act(() => subscription.onRecord({ type: 'log', cursor: 'v3.5.0', data: 'saved', stream: 'stdout', timestamp: 1 }))
    act(() => useSandboxStore.getState().setSandboxStatus('sandbox-a', 'stopping'))
    await waitFor(() => expect(subscription.signal.aborted).toBe(true))
    expect(useSandboxStore.getState().commands[0].logs?.[0].data).toBe('saved')
    expect(followCommandLogs).toHaveBeenCalledOnce()
  })
  it('keeps a single reader through unrelated store updates and process completion', async () => {
    add('cmd-a')
    const screen = render(<CommandLogsStream />)
    await waitFor(() => expect(followCommandLogs).toHaveBeenCalledTimes(1))
    const subscription = vi.mocked(followCommandLogs).mock.calls[0][0]
    act(() => {
      subscription.onRecord({ type: 'log', cursor: 'v3.5.0', data: 'hello', stream: 'stdout', timestamp: 1 })
      add('cmd-a', 'done')
    })
    expect(followCommandLogs).toHaveBeenCalledTimes(1)
    expect(subscription.signal.aborted).toBe(false)
    act(() => subscription.onRecord({ type: 'status', status: 'done', exitCode: 0 }))
    await waitFor(() => expect(subscription.signal.aborted).toBe(true))
    expect(useSandboxStore.getState().commands[0].logsComplete).toBe(true)
    screen.unmount()
  })

  it('drains commands that already finished before mounting', async () => {
    add('cmd-fast', 'done')
    render(<CommandLogsStream />)
    await waitFor(() => expect(followCommandLogs).toHaveBeenCalledTimes(1))
    expect(vi.mocked(followCommandLogs).mock.calls[0][0].cmdId).toBe('cmd-fast')
  })

  it('aborts on project switch and ignores late output from the old sandbox', async () => {
    add('cmd-a')
    render(<CommandLogsStream />)
    const subscription = vi.mocked(followCommandLogs).mock.calls[0][0]
    act(() => useSandboxStore.getState().setSandboxId('sandbox-b'))
    await waitFor(() => expect(subscription.signal.aborted).toBe(true))
    act(() => subscription.onRecord({ type: 'log', cursor: 'v3.4.0', data: 'late', stream: 'stdout', timestamp: 1 }))
    expect(useSandboxStore.getState().commands).toEqual([])
  })

  it('resumes from the saved byte cursor after a component remount', () => {
    add('cmd-a')
    const screen = render(<CommandLogsStream />)
    const subscription = vi.mocked(followCommandLogs).mock.calls[0][0]
    act(() => subscription.onRecord({ type: 'log', cursor: 'v3.10.0', data: 'saved text', stream: 'stdout', timestamp: 1 }))
    screen.unmount()
    expect(subscription.signal.aborted).toBe(true)
    render(<CommandLogsStream />)
    expect(vi.mocked(followCommandLogs).mock.calls[1][0].cursor).toBe('v3.10.0')
  })

  it('never starts more than three simultaneous log readers', () => {
    for (let index = 0; index < 10; index++) add(`cmd-${index}`)
    render(<CommandLogsStream />)
    expect(followCommandLogs).toHaveBeenCalledTimes(3)
  })
})
