// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProjectWorkspaceRegistry } from '@/lib/workspace/project-registry'
import { useSandboxStore } from '@/app/state'
import { CommandLogsStream } from '@/components/commands-logs/commands-logs-stream'
import { followCommandLogs } from '@/lib/commands/follow-logs'

vi.mock('@/lib/commands/follow-logs', () => ({ followCommandLogs: vi.fn() }))
const a = { id: 'a', sandboxId: 'sandbox-a' }, b = { id: 'b', sandboxId: 'sandbox-b' }
let registry: ProjectWorkspaceRegistry
let dispose: () => void
beforeEach(() => {
  useSandboxStore.getState().clearSandbox()
  registry = new ProjectWorkspaceRegistry(); dispose = registry.connect(new AbortController().signal)
  registry.activate(a)
  vi.mocked(followCommandLogs).mockImplementation(({ signal }) => new Promise(resolve => signal.addEventListener('abort', () => resolve(), { once: true })))
})
afterEach(() => { cleanup(); dispose(); vi.resetAllMocks() })
const run = (id: string) => ({ id: `tool-${id}`, type: 'data-run-command' as const,
  data: { sandboxId: a.sandboxId, commandId: id, command: 'node', args: ['main.ts'], status: 'running' as const } })

it('disconnects only the hidden reader and reconnects once from its retained cursor on return', async () => {
  registry.apply(a.id, run('cmd-a'))
  render(<CommandLogsStream />)
  const first = vi.mocked(followCommandLogs).mock.calls[0][0]
  act(() => first.onRecord({ type: 'log', cursor: 'v3.5.0', stream: 'stdout', data: 'hello', timestamp: 1 }))
  act(() => registry.activate(b))
  expect(first.signal.aborted).toBe(true)
  act(() => first.onRecord({ type: 'log', cursor: 'v3.9.0', stream: 'stdout', data: 'late', timestamp: 2 }))
  expect(useSandboxStore.getState().commands).toEqual([])
  await act(async () => {})
  act(() => registry.activate(a))
  await waitFor(() => expect(followCommandLogs).toHaveBeenCalledTimes(2))
  const second = vi.mocked(followCommandLogs).mock.calls[1][0]
  expect(second.cursor).toBe('v3.5.0')
  act(() => second.onRecord({ type: 'log', cursor: 'v3.5.0', stream: 'stdout', data: 'hello', timestamp: 1 }))
  expect(useSandboxStore.getState().commands[0].logs?.map(log => log.data)).toEqual(['hello'])
  act(() => second.onRecord({ type: 'status', status: 'done', exitCode: 0 }))
  expect(second.signal.aborted).toBe(true)
  act(() => registry.activate(b)); act(() => registry.activate(a))
  expect(followCommandLogs).toHaveBeenCalledTimes(2)
  expect(useSandboxStore.getState().commands[0]).toMatchObject({ status: 'done', exitCode: 0, logsComplete: true })
})

it('discovers commands completed during a hidden generation and drains output on return', async () => {
  registry.activate(b)
  render(<CommandLogsStream />)
  act(() => registry.apply(a.id, { ...run('cmd-hidden'), data: { ...run('cmd-hidden').data, status: 'done', exitCode: 0 } }))
  expect(followCommandLogs).not.toHaveBeenCalled()
  expect(useSandboxStore.getState().commands).toEqual([])
  act(() => registry.activate(a))
  await waitFor(() => expect(followCommandLogs).toHaveBeenCalledOnce())
  expect(vi.mocked(followCommandLogs).mock.calls[0][0]).toMatchObject({ sandboxId: a.sandboxId, cmdId: 'cmd-hidden', cursor: undefined })
})
