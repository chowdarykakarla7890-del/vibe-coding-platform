// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandsLogs } from '@/components/commands-logs/commands-logs'
import { Logs } from '@/app/logs'
import { useSandboxStore } from '@/app/state'
import { setCloudAccount } from '@/lib/learning/cloud-request'
import type { Command } from '@/components/commands-logs/types'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
const accountA = '00000000-0000-4000-8000-000000000001'
const accountB = '00000000-0000-4000-8000-000000000002'
const command = (cmdId: string): Command => ({ sandboxId: 'sandbox-a', cmdId, startedAt: 0, command: cmdId, args: [], status: 'running', logs: [] })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { promise, resolve }
}
function enter(value: string) { fireEvent.change(screen.getByRole('textbox', { name: 'Terminal command' }), { target: { value } }) }
function submit() { fireEvent.click(screen.getByRole('button', { name: 'Run command' })) }
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  setCloudAccount(accountA)
  useSandboxStore.getState().clearSandbox()
  useSandboxStore.getState().setSandboxId('sandbox-a')
})
afterEach(() => { cleanup(); setCloudAccount(undefined); useSandboxStore.getState().clearSandbox(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('terminal controls', () => {
  it('keeps failed input, prevents duplicate starts and sends the chosen execution mode', async () => {
    const pending = deferred<boolean>()
    const onRunCommand = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(true)
    render(<CommandsLogs commands={[]} onRunCommand={onRunCommand} />)
    enter('  npm run dev  ')
    fireEvent.change(screen.getByRole('combobox', { name: 'Command execution mode' }), { target: { value: 'server' } })
    submit(); submit()
    expect(onRunCommand).toHaveBeenCalledTimes(1)
    expect(onRunCommand).toHaveBeenCalledWith('npm run dev', true)
    expect((screen.getByRole('textbox') as HTMLInputElement).disabled).toBe(true)
    await act(async () => pending.resolve(false))
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('  npm run dev  ')
    submit()
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(''))
  })

  it('makes rejected starts retryable with an announced error', async () => {
    render(<CommandsLogs commands={[]} onRunCommand={vi.fn().mockRejectedValue(new Error('Network error'))} />)
    enter('pnpm test'); submit()
    expect((await screen.findByRole('alert')).textContent).toContain('Your input has been kept')
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('pnpm test')
    expect((screen.getByRole('button', { name: 'Run command' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('tracks simultaneous Stop requests independently and permits retry on failure', async () => {
    const first = deferred<void>(); const second = deferred<void>()
    const onStopCommand = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockRejectedValueOnce(new Error('Unknown'))
    render(<CommandsLogs commands={[command('first'), command('second')]} onStopCommand={onStopCommand} />)
    const stopFirst = screen.getByRole('button', { name: 'Stop first' }) as HTMLButtonElement
    const stopSecond = screen.getByRole('button', { name: 'Stop second' }) as HTMLButtonElement
    fireEvent.click(stopFirst); fireEvent.click(stopSecond); fireEvent.click(stopFirst)
    expect(onStopCommand).toHaveBeenCalledTimes(2)
    expect(stopFirst.disabled).toBe(true)
    expect(stopSecond.disabled).toBe(true)
    await act(async () => second.resolve())
    expect(stopFirst.disabled).toBe(true)
    expect(stopSecond.disabled).toBe(false)
    await act(async () => first.resolve())
    fireEvent.click(stopFirst)
    expect((await screen.findByRole('alert')).textContent).toContain('Could not stop')
    expect(stopFirst.disabled).toBe(false)
  })
})

describe('terminal response isolation', () => {
  it('does not overwrite output received while a Stop request is pending', async () => {
    const pending = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending.promise))
    useSandboxStore.getState().upsertCommand(command('cmd-a'))
    render(<Logs />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop cmd-a' }))
    act(() => useSandboxStore.getState().upsertCommand({ ...command('cmd-a'), logs: [{ stream: 'stdout', data: 'new output', timestamp: 1 }], logCursor: 'v3.10.0' }))
    await act(async () => pending.resolve(Response.json({ stopped: true })))
    expect(useSandboxStore.getState().commands[0]).toMatchObject({ status: 'done', logCursor: 'v3.10.0', logs: [{ data: 'new output' }] })
    expect(useSandboxStore.getState().commands[0].logsComplete).not.toBe(true)
  })

  it('aborts launch on a sandbox switch and ignores an obsolete response', async () => {
    const pending = deferred<Response>(); const fetcher = vi.fn().mockReturnValue(pending.promise)
    vi.stubGlobal('fetch', fetcher)
    render(<Logs />); enter('sleep 5'); submit()
    const signal = fetcher.mock.calls[0][1].signal as AbortSignal
    act(() => useSandboxStore.getState().setSandboxId('sandbox-b'))
    expect(signal.aborted).toBe(true)
    enter('node current.js')
    await act(async () => pending.resolve(Response.json({ sandboxId: 'sandbox-a', cmdId: 'late', background: false })))
    expect(useSandboxStore.getState().commands).toEqual([])
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('node current.js')
  })

  it('aborts and ignores a launch when the signed-in account changes', async () => {
    const pending = deferred<Response>(); const fetcher = vi.fn().mockReturnValue(pending.promise)
    vi.stubGlobal('fetch', fetcher)
    render(<Logs />); enter('node secret.js'); submit()
    const signal = fetcher.mock.calls[0][1].signal as AbortSignal
    setCloudAccount(accountB)
    expect(signal.aborted).toBe(true)
    await act(async () => pending.resolve(Response.json({ sandboxId: 'sandbox-a', cmdId: 'late', background: false })))
    expect(useSandboxStore.getState().commands).toEqual([])
  })

  it('aborts a pending launch on unmount', () => {
    const fetcher = vi.fn().mockReturnValue(new Promise(() => {}))
    vi.stubGlobal('fetch', fetcher)
    const view = render(<Logs />); enter('node server.js'); submit()
    view.unmount()
    expect((fetcher.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true)
  })
})
