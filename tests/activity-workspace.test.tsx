// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StrictMode, type ReactNode } from 'react'
import { ActivityWorkspace } from '@/components/learning/activity-workspace'
import { useSandboxStore } from '@/app/state'
import { setCloudAccount } from '@/lib/learning/cloud-request'
import { useLearning } from '@/lib/learning/learning-provider'
import { toast } from 'sonner'
import { listFileSnapshots } from '@/lib/learning/db'

vi.mock('@/components/workspace/code-tutor-workspace', () => ({
  CodeTutorWorkspace: ({ activityHeader }: { activityHeader: ReactNode }) => <main>{activityHeader}</main>,
  ActivityHeader: ({ action }: { action: ReactNode }) => <header>{action}</header>,
}))
vi.mock('@/lib/learning/learning-provider', () => ({ useLearning: vi.fn() }))
vi.mock('@/lib/learning/db', () => ({ getGeneratedActivity: vi.fn(), saveFileSnapshots: vi.fn(), listFileSnapshots: vi.fn() }))
vi.mock('@/lib/learning/catalog', () => ({ getActivity: (id: string) => ({ id, mode: 'dsa', language: 'Python', title: id,
  starterFiles: [{ path: 'main.py', content: '# starter' }],
  variants: { Python: { starterFiles: [{ path: 'main.py', content: '# starter' }] }, JavaScript: { starterFiles: [{ path: 'main.js', content: '// starter' }] } } }) }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const account = '11111111-1111-4111-8111-111111111111'
const project = { id: '22222222-2222-4222-8222-222222222222', activityId: 'dsa-test', language: 'JavaScript', sandboxId: 'sandbox-a' }
const result = { passed: true, score: 85, aiAssessed: true, feedback: ['Clear implementation'], commandOutput: '', requestId: 'assessment-a' }
const fetcher = vi.fn(), updateProject = vi.fn(), refreshProgress = vi.fn()
const context = () => ({ activeProject: project, projects: [project], isReady: true,
  createProject: vi.fn(), selectProject: vi.fn(), updateProject, refreshProgress })
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
const mount = () => render(<ActivityWorkspace activityId="dsa-test" mode="dsa" />)

beforeEach(() => {
  setCloudAccount(account)
  vi.stubGlobal('fetch', fetcher)
  fetcher.mockResolvedValue(response(result))
  refreshProgress.mockResolvedValue(undefined)
  vi.mocked(listFileSnapshots).mockResolvedValue([])
  vi.mocked(useLearning).mockReturnValue(context() as unknown as ReturnType<typeof useLearning>)
  useSandboxStore.setState({ sandboxId: project.sandboxId, paths: ['main.js'], dirtyFilePath: undefined })
})

describe('activity startup lifecycle', () => {
  const fresh = { ...project, sandboxId: undefined, language: 'Python' }
  function startContext() {
    vi.mocked(useLearning).mockReturnValue({ ...context(), activeProject: fresh, projects: [fresh] } as unknown as ReturnType<typeof useLearning>)
    useSandboxStore.getState().clearSandbox()
    fetcher.mockImplementation(async (_url: string, init: RequestInit) => response(init.method === 'POST'
      ? { sandboxId: 'sandbox-new' } : init.method === 'DELETE' ? { status: 'stopped' } : { restored: 1 }))
  }
  it('does not overwrite a newly activated workspace when an older activity acknowledgment arrives before effect cleanup', async () => {
    startContext()
    let acknowledge!: () => void
    updateProject.mockResolvedValueOnce(undefined).mockImplementationOnce(() => new Promise<void>(resolve => { acknowledge = resolve }))
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Start activity' }))
    await waitFor(() => expect(updateProject).toHaveBeenCalledTimes(2))
    act(() => {
      useSandboxStore.getState().setSandboxId('sandbox-b')
      useSandboxStore.setState({ projectId: 'other-project' })
    })
    await act(async () => acknowledge())
    expect(useSandboxStore.getState()).toMatchObject({ projectId: 'other-project', sandboxId: 'sandbox-b', paths: [] })
    expect(toast.success).not.toHaveBeenCalled()
  })
  it('preserves the fully restored sandbox and offers reopening after the final project acknowledgment fails', async () => {
    startContext()
    updateProject.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Missing save receipt'))
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Start activity' }))
    const reopen = await screen.findByRole('button', { name: 'Reopen project' })
    expect(screen.getByRole('alert').textContent).toContain('files were restored')
    expect(fetcher.mock.calls.map(([, init]) => init.method)).toEqual(['POST', 'PUT'])
    expect(screen.queryByRole('button', { name: 'Retry startup' })).toBeNull()
    expect(toast.success).not.toHaveBeenCalled()
    act(() => useSandboxStore.getState().setDirtyFilePath('main.py'))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    fireEvent.click(reopen)
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('main.py'))
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('keeps the language choice inside the startup panel and locks it during provisioning', async () => {
    startContext()
    fetcher.mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason))))
    mount()
    const selector = screen.getByRole('combobox', { name: 'Template language' }) as HTMLSelectElement
    expect(selector.closest('[aria-label="Activity startup"]')).not.toBeNull()
    expect(selector.disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Start activity' }))
    expect(selector.disabled).toBe(true)
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel startup' }))
    await screen.findByRole('alert')
    expect(selector.disabled).toBe(false)
  })
  it('creates the project once in Strict Mode and cancels it when its activity unmounts', async () => {
    const create = vi.fn().mockReturnValue(new Promise(() => {}))
    vi.mocked(useLearning).mockReturnValue({ ...context(), activeProject: undefined, projects: [], createProject: create } as unknown as ReturnType<typeof useLearning>)
    const view = render(<StrictMode><ActivityWorkspace activityId="dsa-test" mode="dsa" /></StrictMode>)
    await waitFor(() => expect(create).toHaveBeenCalledOnce())
    expect(create.mock.calls[0][1].aborted).toBe(false)
    view.unmount()
    expect(create.mock.calls[0][1].aborted).toBe(true)
  })
  it('continues saved source rather than overwriting it with starter files', async () => {
    startContext()
    const saved = [{ id: 'file', projectId: project.id, path: 'main.py', content: '# my saved work', size: 15, updatedAt: 1, revision: 3 }]
    vi.mocked(listFileSnapshots).mockResolvedValueOnce(saved)
    mount(); fireEvent.click(screen.getByRole('button', { name: 'Start activity' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(JSON.parse(fetcher.mock.calls.find(([, init]) => init.method === 'PUT')![1].body).files).toEqual([{ path: 'main.py', content: '# my saved work', revision: 3 }])
  })
  it('refuses to mix saved source with a newly selected template language before provisioning', async () => {
    startContext()
    vi.mocked(listFileSnapshots).mockResolvedValueOnce([{ id: 'file', projectId: project.id, path: 'main.py', content: '# saved', size: 7, updatedAt: 1, revision: 1 }])
    mount()
    fireEvent.change(screen.getByRole('combobox', { name: 'Template language' }), { target: { value: 'JavaScript' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start activity' }))
    expect((await screen.findByRole('alert')).textContent).toContain('already has saved Python source')
    expect(fetcher).not.toHaveBeenCalled(); expect(updateProject).not.toHaveBeenCalled()
  })
  it('aborts on account change and never sends cleanup with the replacement account', async () => {
    startContext()
    let finish!: (value: Response) => void
    fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    mount(); fireEvent.click(screen.getByRole('button', { name: 'Start activity' }))
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    setCloudAccount('33333333-3333-4333-8333-333333333333')
    await act(async () => finish(response({ sandboxId: 'sandbox-new' })))
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(toast.success).not.toHaveBeenCalled()
    expect(useSandboxStore.getState().sandboxId).toBeUndefined()
  })
  it('saves the chosen language before provisioning and scopes all requests to the initiating account', async () => {
    startContext(); mount()
    fireEvent.change(screen.getByRole('combobox', { name: 'Template language' }), { target: { value: 'JavaScript' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start activity' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Activity workspace is ready'))
    expect(updateProject.mock.invocationCallOrder[0]).toBeLessThan(fetcher.mock.invocationCallOrder[0])
    expect(updateProject.mock.calls[0].slice(0, 2)).toEqual([project.id, { language: 'JavaScript' }])
    for (const [, init] of fetcher.mock.calls) {
      expect(new Headers(init.headers).get('X-CodeTutor-Account')).toBe(account)
      expect(init.signal).toBeInstanceOf(AbortSignal)
    }
    expect(JSON.parse(fetcher.mock.calls.find(([, init]) => init.method === 'PUT')![1].body).files).toEqual([{ path: 'main.js', content: '// starter', revision: 0 }])
    expect(useSandboxStore.getState()).toMatchObject({ sandboxId: 'sandbox-new', paths: ['main.js'] })
  })
  it('requires the exact starter upload receipt before publishing a workspace', async () => {
    startContext()
    fetcher.mockResolvedValueOnce(response({ sandboxId: 'sandbox-new' })).mockResolvedValueOnce(response({ restored: 0 }))
    mount(); fireEvent.click(screen.getByRole('button', { name: 'Start activity' }))
    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init.method === 'DELETE')).toBe(true))
    expect(toast.success).not.toHaveBeenCalled()
    expect(useSandboxStore.getState().sandboxId).toBeUndefined()
    expect(await screen.findByRole('alert')).toBeTruthy()
  })
  it('cancels an in-flight start on unmount without continuing to upload or publish', async () => {
    startContext()
    let finish!: (value: Response) => void
    fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const view = mount(); fireEvent.click(screen.getByRole('button', { name: 'Start activity' }))
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    const signal = fetcher.mock.calls[0][1].signal
    view.unmount()
    expect(signal?.aborted).toBe(true)
    await act(async () => finish(response({ sandboxId: 'sandbox-new' })))
    expect(fetcher.mock.calls.some(([, init]) => init.method === 'PUT')).toBe(false)
    expect(toast.success).not.toHaveBeenCalled()
    expect(useSandboxStore.getState().sandboxId).toBeUndefined()
  })
  it('offers cancellation immediately and never starts a second request on double click', async () => {
    startContext()
    fetcher.mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason))))
    mount(); const start = screen.getByRole('button', { name: 'Start activity' })
    fireEvent.click(start); fireEvent.click(start)
    const cancel = await screen.findByRole('button', { name: 'Cancel startup' })
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    fireEvent.click(cancel)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(toast.success).not.toHaveBeenCalled()
  })
  it('never publishes a late start into another visible project', async () => {
    startContext()
    let finish!: (value: Response) => void
    fetcher.mockResolvedValueOnce(response({ sandboxId: 'sandbox-new' }))
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const view = mount(); fireEvent.click(screen.getByRole('button', { name: 'Start activity' }))
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    vi.mocked(useLearning).mockReturnValue({ ...context(), activeProject: { id: 'other-project' }, projects: [fresh] } as unknown as ReturnType<typeof useLearning>)
    useSandboxStore.getState().setSandboxId('sandbox-other')
    view.rerender(<ActivityWorkspace activityId="dsa-test" mode="dsa" />)
    await act(async () => finish(response({ restored: 1 })))
    expect(useSandboxStore.getState().sandboxId).toBe('sandbox-other')
    expect(toast.success).not.toHaveBeenCalled()
  })
})
afterEach(() => { cleanup(); setCloudAccount(undefined); vi.resetAllMocks(); vi.unstubAllGlobals() })

describe('activity submission lifecycle', () => {
  it('cancels before dispatch without sending a paid request', async () => {
    mount(); fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel verification' }))
    await act(async () => undefined)
    expect(fetcher).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('already-saved assessment')
    expect((screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('cancels a stalled request, preserves source, and ignores its result during an explicit retry', async () => {
    let finish!: (value: Response) => void
    fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    mount(); fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel verification' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel verification' })).toBeNull())
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true)
    expect(useSandboxStore.getState()).toMatchObject({ sandboxId: project.sandboxId, paths: ['main.js'] })
    expect(screen.getByRole('alert').textContent).toContain('submission history')
    fetcher.mockResolvedValueOnce(response({ ...result, score: 70 }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    await screen.findByText('70% Passed')
    await act(async () => finish(response({ ...result, score: 100 })))
    expect(screen.queryByText('100% Passed')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(refreshProgress).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('settles a stalled progress refresh without losing the acknowledged assessment', async () => {
    vi.useFakeTimers()
    refreshProgress.mockReturnValueOnce(new Promise(() => {}))
    fetcher.mockResolvedValueOnce(response(result))
    try {
      mount(); fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      expect(screen.getByText('85% Passed')).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Cancel verification' })).toBeNull()
      await act(async () => { await vi.advanceTimersByTimeAsync(20_001) })
      expect(screen.getByText('85% Passed')).toBeTruthy()
      expect((screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement).disabled).toBe(false)
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('assessment was saved'))
    } finally { vi.useRealTimers() }
  })

  it.each(['headers', 'body'])('settles stalled verification %s and ignores a late score', async stage => {
    vi.useFakeTimers()
    let finish!: (value: unknown) => void
    const pending = new Promise(resolve => { finish = resolve })
    fetcher.mockImplementation(() => stage === 'headers' ? pending : Promise.resolve({ ok: true, json: () => pending }))
    mount(); fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(160_001) })
      expect((screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement).disabled).toBe(false)
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('submission history'))
      await act(async () => finish(stage === 'headers' ? response(result) : result))
      expect(screen.queryByText('AI assessed')).toBeNull()
      expect(refreshProgress).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })
  it('labels deterministic assessments as trusted checks rather than AI review', async () => {
    fetcher.mockResolvedValueOnce(response({ ...result, score: 100, aiAssessed: false }))
    mount(); fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(await screen.findByText('Trusted checks')).toBeTruthy()
    expect(screen.queryByText('AI assessed')).toBeNull()
    expect(toast.success).toHaveBeenCalledWith('100% — trusted checks')
  })
  it('submits once without reading snapshots or rewriting source/project completion', async () => {
    mount(); fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(await screen.findByText('AI assessed')).toBeTruthy()
    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe('/api/activities/verify')
    expect(new Headers(init.headers).get('X-CodeTutor-Account')).toBe(account)
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(init.body)).toMatchObject({ projectId: project.id, language: 'JavaScript', sandboxId: project.sandboxId })
    expect(updateProject).not.toHaveBeenCalled()
    expect(refreshProgress).toHaveBeenCalledOnce()
  })
  it('blocks submission of an unsaved editor draft', () => {
    useSandboxStore.setState({ dirtyFilePath: 'main.js' })
    mount(); const submit = screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.click(submit); expect(fetcher).not.toHaveBeenCalled()
    expect(useSandboxStore.getState().dirtyFilePath).toBe('main.js')
  })
  it('prevents duplicate submission while the first response is pending', async () => {
    let complete!: (response: Response) => void
    fetcher.mockImplementation(() => new Promise((resolve) => { complete = resolve }))
    mount(); const submit = screen.getByRole('button', { name: 'Submit' })
    fireEvent.click(submit); fireEvent.click(submit)
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    await act(async () => complete(response(result)))
    expect(screen.getByText('AI assessed')).toBeTruthy()
  })
  it('aborts on unmount and ignores an already-in-flight late response', async () => {
    let complete!: (response: Response) => void
    fetcher.mockImplementation(() => new Promise((resolve) => { complete = resolve }))
    const view = mount(); fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    const signal = fetcher.mock.calls[0][1].signal
    view.unmount(); expect(signal.aborted).toBe(true)
    await act(async () => complete(response(result)))
    expect(refreshProgress).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })
  it('aborts when another project becomes visible and does not show its predecessor result', async () => {
    let complete!: (response: Response) => void
    fetcher.mockImplementation(() => new Promise((resolve) => { complete = resolve }))
    const view = mount(); fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    vi.mocked(useLearning).mockReturnValue({ ...context(), activeProject: { id: 'other-project' } } as unknown as ReturnType<typeof useLearning>)
    view.rerender(<ActivityWorkspace activityId="dsa-test" mode="dsa" />)
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true)
    await act(async () => complete(response(result)))
    expect(screen.queryByText('AI assessed')).toBeNull()
    expect(refreshProgress).not.toHaveBeenCalled()
  })
  it('does not adopt results or send follow-up writes after account switching', async () => {
    let complete!: (response: Response) => void
    fetcher.mockImplementation(() => new Promise((resolve) => { complete = resolve }))
    mount(); fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    setCloudAccount('33333333-3333-4333-8333-333333333333')
    await act(async () => complete(response(result)))
    expect(refreshProgress).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })
  it('retains a saved assessment when progress refresh fails', async () => {
    refreshProgress.mockRejectedValue(new Error('offline'))
    mount(); fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(await screen.findByText('AI assessed')).toBeTruthy()
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('assessment was saved')))
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('settles expired and malformed responses without clearing the workspace', async () => {
    fetcher.mockResolvedValueOnce(response({ error: { code: 'SANDBOX_EXPIRED', message: 'Restore the activity.' } }, 410))
      .mockResolvedValueOnce(response({ unexpected: true }))
    mount(); fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Restore the activity.'))
    expect(useSandboxStore.getState().sandboxId).toBe(project.sandboxId)
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The verification response was invalid.'))
    expect(updateProject).not.toHaveBeenCalled()
    expect(refreshProgress).not.toHaveBeenCalled()
  })
  it('loads the new manifest instead of retaining the preceding route activity', async () => {
    const view = mount()
    vi.mocked(useLearning).mockReturnValue({ ...context(), activeProject: undefined, projects: [], createProject: vi.fn().mockResolvedValue({}) } as unknown as ReturnType<typeof useLearning>)
    view.rerender(<ActivityWorkspace activityId="dsa-another" mode="dsa" />)
    expect(screen.getByText('dsa-another')).toBeTruthy()
    expect(screen.queryByText('dsa-test')).toBeNull()
  })
  it('turns project-creation failures into a retryable state instead of an unhandled rejection', async () => {
    const createProject = vi.fn().mockRejectedValueOnce(new Error('Storage unavailable')).mockResolvedValueOnce({})
    vi.mocked(useLearning).mockReturnValue({ ...context(), activeProject: undefined, projects: [], createProject } as unknown as ReturnType<typeof useLearning>)
    mount()
    expect((await screen.findByRole('alert')).textContent).toContain('Storage unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Retry project creation' }))
    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })
})
