// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorMonitor, ErrorMonitorNotice } from '@/components/error-monitor/error-monitor'
import { getSummary } from '@/components/error-monitor/get-summary'
import { useSandboxStore } from '@/app/state'
import { setCloudAccount } from '@/lib/learning/cloud-request'

const fixtures = vi.hoisted(() => ({
  learning: { activeProject: { id: 'project-a', sandboxId: 'sandbox-a' } },
  settings: { fixErrors: true, modelId: 'openai/gpt-5-nano', reasoningEffort: 'low' },
  chat: { sendMessage: vi.fn(), status: 'ready' },
}))
vi.mock('@/components/error-monitor/get-summary', () => ({ getSummary: vi.fn() }))
vi.mock('@/lib/learning/learning-provider', () => ({ useLearning: () => fixtures.learning }))
vi.mock('@/components/settings/use-settings', () => ({ useSettings: () => fixtures.settings }))
vi.mock('@/lib/chat-context', () => ({ useSharedChatContext: () => ({ chatState: fixtures.chat }) }))
const summary = { shouldBeFixed: true, summary: 'Fix invalid input', paths: ['main.ts'] }
function tree() { return <StrictMode><ErrorMonitor debounceTimeMs={100}><p>Workspace intact</p><ErrorMonitorNotice /></ErrorMonitor></StrictMode> }
function output(data: string, cmdId = 'cmd1') {
  const state = useSandboxStore.getState()
  state.upsertCommand({ sandboxId: state.sandboxId!, cmdId, command: 'node', args: [], background: true, status: 'running', logs: [{ data, stream: 'stderr', timestamp: 1 }] })
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(100_000)
  setCloudAccount('11111111-1111-4111-8111-111111111111')
  fixtures.learning.activeProject = { id: 'project-a', sandboxId: 'sandbox-a' }
  fixtures.settings.fixErrors = true; fixtures.chat.status = 'ready'
  fixtures.chat.sendMessage.mockResolvedValue(undefined)
  useSandboxStore.getState().setSandboxId('sandbox-a')
  vi.mocked(getSummary).mockResolvedValue(summary)
})
afterEach(() => { cleanup(); setCloudAccount(undefined); useSandboxStore.getState().clearSandbox(); vi.resetAllMocks(); vi.useRealTimers() })
describe('project-scoped automatic diagnostics', () => {
  it('leaves routine server traffic alone, including Strict Mode setup/cleanup', async () => {
    output('100.64.0.1 - - [27/Aug/2026 23:42:18] "GET /error HTTP/1.1" 200 -\n')
    render(tree())
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
    expect(getSummary).not.toHaveBeenCalled()
    expect(fixtures.chat.sendMessage).not.toHaveBeenCalled()
    expect(screen.getByText('Workspace intact')).toBeTruthy()
  })
  it('reports a real failure exactly once with the captured project/model context', async () => {
    output('TypeError: invalid input\n')
    render(tree())
    expect(screen.getByRole('status').textContent).toContain('Checking command errors')
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(getSummary).toHaveBeenCalledOnce()
    expect(fixtures.chat.sendMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: expect.stringContaining('Fix invalid input') }), { body: { projectId: 'project-a', modelId: 'openai/gpt-5-nano', reasoningEffort: 'low' } })
    act(() => output('TypeError: invalid input\nINFO: ready\n'))
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
    expect(getSummary).toHaveBeenCalledOnce()
    expect(screen.queryByRole('status')).toBeNull()
  })
  it.each(['project', 'sandbox', 'expiry', 'disabled', 'chat', 'account', 'unmount'] as const)('cancels late analysis after %s changes', async change => {
    let finish!: (value: typeof summary) => void
    vi.mocked(getSummary).mockReturnValue(new Promise(resolve => { finish = resolve }))
    output('TypeError: invalid input\n')
    const view = render(tree())
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    const signal = vi.mocked(getSummary).mock.calls[0][3]!
    if (change === 'unmount') view.unmount()
    else {
      act(() => {
        if (change === 'project') fixtures.learning.activeProject = { id: 'project-b', sandboxId: 'sandbox-b' }
        if (change === 'sandbox') { fixtures.learning.activeProject = { id: 'project-a', sandboxId: 'sandbox-new' }; useSandboxStore.getState().setSandboxId('sandbox-new') }
        if (change === 'expiry') useSandboxStore.getState().setSandboxStatus('sandbox-a', 'stopped')
        if (change === 'disabled') fixtures.settings.fixErrors = false
        if (change === 'chat') fixtures.chat.status = 'streaming'
        if (change === 'account') setCloudAccount('22222222-2222-4222-8222-222222222222')
      })
      view.rerender(tree())
    }
    expect(signal.aborted).toBe(true)
    await act(async () => { finish(summary); await vi.advanceTimersByTimeAsync(0) })
    expect(fixtures.chat.sendMessage).not.toHaveBeenCalled()
  })
  it('shows recoverable failure, waits for explicit Retry, and clears the notice on success', async () => {
    vi.mocked(getSummary).mockRejectedValueOnce(new Error('AI service unavailable'))
    output('TypeError: invalid input\n')
    render(tree())
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(screen.getByRole('status').textContent).toContain('Automatic diagnostics paused')
    act(() => output('TypeError: another failure\n', 'cmd2'))
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(getSummary).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Retry analysis' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(getSummary).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('button', { name: 'Retry analysis' })).toBeNull()
  })
  it('preserves inspected history across project switches without mixing conversations', async () => {
    output('TypeError: invalid input\n')
    const view = render(tree())
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    fixtures.learning.activeProject = { id: 'project-b', sandboxId: 'sandbox-b' }
    act(() => useSandboxStore.getState().setSandboxId('sandbox-b'))
    view.rerender(tree())
    fixtures.learning.activeProject = { id: 'project-a', sandboxId: 'sandbox-a' }
    act(() => { useSandboxStore.getState().setSandboxId('sandbox-a'); output('TypeError: invalid input\n') })
    view.rerender(tree())
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
    expect(getSummary).toHaveBeenCalledOnce()
  })
})
