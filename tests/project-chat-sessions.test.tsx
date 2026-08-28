// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ChatProvider, useSharedChatContext } from '@/lib/chat-context'
import { setCloudAccount } from '@/lib/learning/cloud-request'
import { useSandboxStore } from '@/app/state'
import type { UIMessageChunk } from 'ai'
import { useLayoutEffect } from 'react'

const fixture = vi.hoisted(() => ({
  learning: { activeProjectId: 'project-a', isReady: true, projects: [{ id: 'project-a' }, { id: 'project-b' }], updateProject: vi.fn() },
  load: vi.fn(), stop: vi.fn(), toast: vi.fn(),
}))
vi.mock('@/lib/learning/learning-provider', () => ({ useLearning: () => fixture.learning }))
vi.mock('@/lib/learning/db', () => ({ loadChat: (...args: unknown[]) => fixture.load(...args), stopProjectChat: (...args: unknown[]) => fixture.stop(...args) }))
vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => fixture.toast(...args) } }))

const accountA = '550e8400-e29b-41d4-a716-446655440000'
const accountB = '550e8400-e29b-41d4-a716-446655440001'
const streams = new Map<string, { emit: (...parts: UIMessageChunk[]) => void; close: () => void; signal: AbortSignal }>()
let context: ReturnType<typeof useSharedChatContext>
function Probe() {
  const value = useSharedChatContext()
  useLayoutEffect(() => { context = value }, [value])
  const { chatState, interrupted, operation, recoveryError, stalled, stop, retry } = value
  return <div>
    <output data-testid="state">{JSON.stringify({ status: chatState.status, interrupted, operation, recoveryError, stalled, persistenceStatus: chatState.messages.at(-1)?.metadata?.persistenceStatus, text: chatState.messages.map(message => message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('')).join('|') })}</output>
    <button onClick={() => void chatState.sendMessage({ text: 'Explain loops' })}>Send</button>
    <button onClick={() => void stop()}>Stop</button>
    <button onClick={() => void retry()}>Retry</button>
  </div>
}
const tree = () => <ChatProvider><Probe /></ChatProvider>
const flush = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0) }) }
function state() { return JSON.parse(screen.getByTestId('state').textContent!) }
async function switchProject(view: ReturnType<typeof render>, id: string) {
  fixture.learning.activeProjectId = id
  view.rerender(tree())
  await flush()
}
async function submit() {
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await flush()
  return streams.get(fixture.learning.activeProjectId)!
}

beforeEach(() => {
  vi.useFakeTimers()
  setCloudAccount(accountA)
  fixture.learning.activeProjectId = 'project-a'
  fixture.learning.projects = [{ id: 'project-a' }, { id: 'project-b' }]
  fixture.learning.updateProject.mockResolvedValue(undefined)
  fixture.load.mockResolvedValue([])
  fixture.stop.mockResolvedValue(undefined)
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.stubGlobal('fetch', vi.fn((_path, init: RequestInit) => {
    const projectId = JSON.parse(String(init.body)).projectId
    const signal = init.signal!
    const encoder = new TextEncoder()
    let closed = false
    return Promise.resolve(new Response(new ReadableStream({
      start(controller) {
        const stop = () => { if (!closed) { closed = true; controller.error(new DOMException('Stopped', 'AbortError')) } }
        signal.addEventListener('abort', stop, { once: true })
        streams.set(projectId, {
          signal,
          emit: (...parts) => { if (!closed) parts.forEach(part => controller.enqueue(encoder.encode(`data: ${JSON.stringify(part)}\n\n`))) },
          close: () => { if (!closed) { closed = true; signal.removeEventListener('abort', stop); controller.close() } },
        })
        // Native fetch also rejects when cancellation preceded dispatch.
        if (signal.aborted) stop()
      }, cancel() { closed = true },
    }), { headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } }))
  }))
})
afterEach(async () => {
  cleanup()
  setCloudAccount(undefined)
  for (const stream of streams.values()) stream.close()
  streams.clear()
  useSandboxStore.getState().clearSandbox()
  await vi.advanceTimersByTimeAsync(0)
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetAllMocks()
})

it('keeps the no-progress watchdog running for a hidden project and retains its stalled recovery', async () => {
  const view = render(tree()); await flush()
  const a = await submit()
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  await switchProject(view, 'project-b')
  await act(async () => { await vi.advanceTimersByTimeAsync(30_001) })
  expect(a.signal.aborted).toBe(true)
  expect(state()).toMatchObject({ status: 'ready', stalled: false, text: '' })
  await switchProject(view, 'project-a')
  expect(state()).toMatchObject({ status: 'ready', stalled: true })
})

it('keeps manual Stop recovery before first output when switching away and back', async () => {
  const view = render(tree()); await flush()
  const a = await submit()
  fireEvent.click(screen.getByRole('button', { name: 'Stop' })); await flush()
  expect(a.signal.aborted).toBe(true)
  await switchProject(view, 'project-b')
  await switchProject(view, 'project-a')
  expect(state()).toMatchObject({ status: 'ready', interrupted: true })
})

it('does not disable background monitoring when the next project fails to load', async () => {
  const view = render(tree()); await flush()
  const a = await submit()
  fixture.load.mockRejectedValueOnce(new Error('Storage unavailable'))
  await switchProject(view, 'project-b')
  expect(screen.getByRole('button', { name: 'Retry conversation' })).toBeTruthy()
  await act(async () => { await vi.advanceTimersByTimeAsync(90_001) })
  expect(a.signal.aborted).toBe(true)
})

it('continues progressive output in A without rendering it or its sandbox in B', async () => {
  const view = render(tree()); await flush()
  const a = await submit()
  await switchProject(view, 'project-b')
  useSandboxStore.getState().setSandboxId('sandbox-b')
  await act(async () => {
    a.emit({ type: 'start', messageId: 'assistant-a' }, { type: 'text-start', id: 'text' }, { type: 'text-delta', id: 'text', delta: 'Only A' },
      { type: 'data-create-sandbox', id: 'create-a', data: { sandboxId: 'sandbox-a', status: 'done' } })
    await vi.advanceTimersByTimeAsync(50)
  })
  expect(state().text).toBe('')
  expect(useSandboxStore.getState().sandboxId).toBe('sandbox-b')
  expect(fixture.learning.updateProject).toHaveBeenCalledWith('project-a', { sandboxId: 'sandbox-a' }, expect.anything())
  await act(async () => { a.emit({ type: 'text-end', id: 'text' }, { type: 'finish', finishReason: 'stop' }); a.close(); await vi.advanceTimersByTimeAsync(50) })
  await switchProject(view, 'project-a')
  expect(state()).toMatchObject({ status: 'ready', text: 'Explain loops|Only A' })
})

it('restores background files, commands and preview to A without projecting them into B', async () => {
  const view = render(tree()); await flush()
  const a = await submit()
  await switchProject(view, 'project-b')
  act(() => useSandboxStore.getState().setSandboxId('sandbox-b'))
  await act(async () => {
    a.emit({ type: 'start', messageId: 'assistant-a' },
      { type: 'data-create-sandbox', id: 'create-a', data: { sandboxId: 'sandbox-a', status: 'done' } },
      { type: 'data-generating-files', id: 'files-a', data: { sandboxId: 'sandbox-a', paths: ['main.ts'], status: 'done' } },
      { type: 'data-run-command', id: 'command-a', data: { sandboxId: 'sandbox-a', commandId: 'cmd-a', command: 'node', args: ['main.ts'], status: 'done', exitCode: 0 } },
      { type: 'data-get-sandbox-url', id: 'preview-a', data: { sandboxId: 'sandbox-a', url: 'https://a.vercel.run', status: 'done' } },
      { type: 'finish', finishReason: 'stop' })
    a.close(); await vi.advanceTimersByTimeAsync(50)
  })
  expect(useSandboxStore.getState()).toMatchObject({ sandboxId: 'sandbox-b', commands: [], paths: [], url: undefined })
  await switchProject(view, 'project-a')
  expect(useSandboxStore.getState()).toMatchObject({ sandboxId: 'sandbox-a', paths: ['main.ts'], url: 'https://a.vercel.run', commands: [{ cmdId: 'cmd-a', status: 'done', exitCode: 0 }] })
})

it('keeps manual terminal output, cursors, selection and expiration when returning to a project', async () => {
  const view = render(tree()); await flush()
  act(() => {
    const store = useSandboxStore.getState()
    store.setSandboxId('sandbox-a'); store.addPaths(['a.ts']); store.setActiveFile('a.ts')
    store.upsertCommand({ sandboxId: 'sandbox-a', cmdId: 'manual-a', command: 'node', args: ['a.ts'], status: 'done' })
    store.addLog({ sandboxId: 'sandbox-a', cmdId: 'manual-a', cursor: 'v3.5.0', log: { stream: 'stdout', data: 'hello', timestamp: 1 } })
    store.setSandboxStatus('sandbox-a', 'stopped')
  })
  await switchProject(view, 'project-b')
  expect(useSandboxStore.getState().commands).toEqual([])
  act(() => useSandboxStore.getState().setSandboxId('sandbox-b'))
  await switchProject(view, 'project-a')
  expect(useSandboxStore.getState()).toMatchObject({ sandboxId: 'sandbox-a', status: 'stopped', activeFile: 'a.ts', paths: ['a.ts'], commands: [{ cmdId: 'manual-a', logCursor: 'v3.5.0', logs: [{ data: 'hello' }] }] })
})

it('aborts a deleted project stream and disposes its watchdog', async () => {
  const view = render(tree()); await flush()
  const a = await submit()
  fixture.learning.projects = [{ id: 'project-b' }]
  await switchProject(view, 'project-b')
  expect(a.signal.aborted).toBe(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(90_001) })
  expect(fixture.toast).not.toHaveBeenCalled()
})

async function startAssistant(stream: NonNullable<ReturnType<typeof streams.get>>) {
  await act(async () => {
    stream.emit({ type: 'start', messageId: 'assistant-a', messageMetadata: { model: 'Tutor', persistenceStatus: 'pending', requestId: accountA } },
      { type: 'text-start', id: 'text' }, { type: 'text-delta', id: 'text', delta: 'Partial response' })
    await vi.advanceTimersByTimeAsync(50)
  })
}
const savedResponse = (persistenceStatus: 'complete' | 'interrupted' | 'pending') => [{
  id: 'assistant-a', role: 'assistant', metadata: { model: 'Tutor', persistenceStatus }, parts: [{ type: 'text', text: 'Saved response' }],
}]

it('does not fabricate a saved interruption when the Stop request fails; Retry only reconciles', async () => {
  render(tree()); await flush()
  await startAssistant(await submit())
  fixture.stop.mockRejectedValueOnce(new Error('Private upstream failure'))
  fireEvent.click(screen.getByRole('button', { name: 'Stop' })); await flush()
  expect(state()).toMatchObject({ status: 'error', persistenceStatus: 'pending', recoveryError: expect.stringContaining('Could not confirm') })
  expect(fixture.load).toHaveBeenCalledTimes(1)
  // A failed confirmation must not automatically poll or begin another paid run.
  await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })
  expect(fixture.load).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Send' })); await flush()
  expect(fetch).toHaveBeenCalledOnce()
  fixture.load.mockResolvedValueOnce(savedResponse('complete'))
  fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await flush()
  expect(state()).toMatchObject({ status: 'ready', interrupted: false, stalled: false, persistenceStatus: 'complete', text: 'Saved response' })
  expect(state().recoveryError).toBeUndefined()
  expect(fetch).toHaveBeenCalledOnce()
})

it('keeps the authoritative completed answer when it wins a Stop race', async () => {
  render(tree()); await flush()
  await startAssistant(await submit())
  fixture.load.mockResolvedValueOnce(savedResponse('complete'))
  fireEvent.click(screen.getByRole('button', { name: 'Stop' })); await flush()
  expect(fixture.stop).toHaveBeenCalledWith('project-a', 'assistant-a', accountA, expect.anything())
  expect(state()).toMatchObject({ status: 'ready', interrupted: false, persistenceStatus: 'complete', text: 'Saved response' })
})

it('blocks duplicate Stop, Retry and Send while confirming, including stale handlers', async () => {
  render(tree()); await flush()
  await startAssistant(await submit())
  const stale = context
  let finish!: () => void
  fixture.stop.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
  fireEvent.click(screen.getByRole('button', { name: 'Stop' })); await flush()
  expect(state()).toMatchObject({ status: 'submitted', operation: 'stopping' })
  await act(async () => { await Promise.all([stale.stop(), stale.retry(), stale.chatState.sendMessage({ text: 'Duplicate' })]) })
  expect(fixture.stop).toHaveBeenCalledOnce()
  expect(fetch).toHaveBeenCalledOnce()
  fixture.load.mockResolvedValueOnce(savedResponse('interrupted'))
  await act(async () => finish()); await flush()
  expect(state()).toMatchObject({ status: 'ready', interrupted: true, persistenceStatus: 'interrupted' })
})

it('finishes a background Stop in its originating project without touching the visible conversation', async () => {
  const view = render(tree()); await flush()
  await startAssistant(await submit())
  let finish!: () => void
  fixture.stop.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
  fireEvent.click(screen.getByRole('button', { name: 'Stop' })); await flush()
  await switchProject(view, 'project-b')
  fixture.load.mockResolvedValueOnce(savedResponse('interrupted'))
  await act(async () => finish()); await flush()
  expect(fixture.load).toHaveBeenLastCalledWith('project-a', expect.anything())
  expect(state()).toMatchObject({ status: 'ready', interrupted: false, text: '' })
  await switchProject(view, 'project-a')
  expect(state()).toMatchObject({ status: 'ready', interrupted: true, text: 'Saved response' })
})

it.each(['account', 'unmount', 'delete'] as const)('cancels a pending Stop and ignores its late receipt after %s', async change => {
  const view = render(tree()); await flush()
  await startAssistant(await submit())
  const stale = context
  let finish!: () => void
  fixture.stop.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
  fireEvent.click(screen.getByRole('button', { name: 'Stop' })); await flush()
  const stopSignal = fixture.stop.mock.calls[0][3] as AbortSignal
  if (change === 'account') act(() => setCloudAccount(accountB))
  if (change === 'unmount') view.unmount()
  if (change === 'delete') { fixture.learning.projects = [{ id: 'project-b' }]; await switchProject(view, 'project-b') }
  expect(stopSignal.aborted).toBe(true)
  const reads = fixture.load.mock.calls.length
  await act(async () => finish()); await flush()
  await act(async () => { await stale.retry(); await stale.chatState.sendMessage({ text: 'Obsolete' }) })
  expect(fixture.load).toHaveBeenCalledTimes(reads)
  expect(fetch).toHaveBeenCalledOnce()
  expect(fixture.toast).not.toHaveBeenCalled()
})

it('bounds a missing Stop receipt and permits only read reconciliation after timeout', async () => {
  render(tree()); await flush()
  await startAssistant(await submit())
  fixture.stop.mockImplementationOnce(() => new Promise(() => {}))
  fireEvent.click(screen.getByRole('button', { name: 'Stop' })); await flush()
  await act(async () => { await vi.advanceTimersByTimeAsync(20_001) })
  expect((fixture.stop.mock.calls[0][3] as AbortSignal).aborted).toBe(true)
  expect(state()).toMatchObject({ status: 'error', persistenceStatus: 'pending' })
  fixture.load.mockResolvedValueOnce(savedResponse('pending'))
  fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await flush()
  expect(state().status).toBe('streaming')
  expect(fetch).toHaveBeenCalledOnce()
  fixture.load.mockResolvedValueOnce(savedResponse('interrupted'))
  await act(async () => { await vi.advanceTimersByTimeAsync(3_001) })
  expect(state()).toMatchObject({ status: 'ready', interrupted: true })
})

it('deduplicates submissions made before the first render or SDK conversion completes', async () => {
  render(tree()); await flush()
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await flush()
  expect(fetch).toHaveBeenCalledOnce()
  expect(state().text).toBe('Explain loops')
})

it('honors Stop even when clicked before the SDK has finished preparing the input', async () => {
  render(tree()); await flush()
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  fireEvent.click(screen.getByRole('button', { name: 'Stop' })); await flush()
  expect(streams.get('project-a')!.signal.aborted).toBe(true)
  expect(state()).toMatchObject({ status: 'ready', interrupted: true })
})

it('retains a provider failure in the originating project and permits an explicit retry', async () => {
  const view = render(tree()); await flush()
  const a = await submit()
  await switchProject(view, 'project-b')
  await act(async () => { a.emit({ type: 'error', errorText: 'Provider unavailable' }); a.close(); await vi.advanceTimersByTimeAsync(50) })
  expect(state().status).toBe('ready')
  expect(fixture.toast).not.toHaveBeenCalled()
  await switchProject(view, 'project-a')
  expect(state().status).toBe('error')
  fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await flush()
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(state().status).toBe('submitted')
})

it('retries a stopped request once with a fresh stream and clears recovery state', async () => {
  render(tree()); await flush()
  const a = await submit()
  fireEvent.click(screen.getByRole('button', { name: 'Stop' })); await flush()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await flush()
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(a.signal.aborted).toBe(true)
  expect(streams.get('project-a')!.signal.aborted).toBe(false)
  expect(state()).toMatchObject({ status: 'submitted', interrupted: false, stalled: false })
})

it('keeps independent watchdogs for simultaneous projects and resets only on their own progress', async () => {
  const view = render(tree()); await flush()
  const a = await submit()
  await switchProject(view, 'project-b')
  const b = await submit()
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  await startAssistant(a)
  fixture.load.mockResolvedValue(savedResponse('interrupted'))
  await act(async () => { await vi.advanceTimersByTimeAsync(30_001) })
  expect(b.signal.aborted).toBe(true)
  expect(a.signal.aborted).toBe(false)
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  expect(a.signal.aborted).toBe(true)
  expect(fixture.stop).toHaveBeenCalledWith('project-a', 'assistant-a', accountA, expect.anything())
  await switchProject(view, 'project-a')
  expect(state()).toMatchObject({ status: 'ready', stalled: true })
})

it('ignores a delayed initial history read after the account changes', async () => {
  let finish!: (value: unknown) => void
  fixture.load.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  render(tree()); await flush()
  const signal = fixture.load.mock.calls[0][1] as AbortSignal
  act(() => setCloudAccount(accountB))
  expect(signal.aborted).toBe(true)
  await act(async () => finish(savedResponse('complete'))); await flush()
  expect(screen.queryByTestId('state')).toBeNull()
  expect(screen.queryByText('Saved response')).toBeNull()
})

it('stops background streams on provider disposal and does not report cancellation as a failure', async () => {
  const view = render(tree()); await flush()
  const a = await submit()
  await switchProject(view, 'project-b'); const b = await submit()
  view.unmount(); await flush()
  expect(a.signal.aborted).toBe(true)
  expect(b.signal.aborted).toBe(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(90_001) })
  expect(fixture.toast).not.toHaveBeenCalled()
  expect(console.error).not.toHaveBeenCalled()
})
