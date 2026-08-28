// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SandboxState } from '@/components/modals/sandbox-state'
import { useSandboxStore } from '@/app/state'
import { readSandboxLifecycle, restoreProjectSandbox, SandboxReopenRequiredError } from '@/lib/learning/sandbox-recovery'
import type { ComponentProps } from 'react'

const learning = vi.hoisted(() => ({
  activeProject: { id: 'project-a', sandboxId: 'sbx_old' },
  updateProject: vi.fn(async () => undefined),
  failRecoveryRender: false,
  recoveryRenderError: new Error('Simulated recovery render failure') as unknown,
}))
vi.mock('@/lib/learning/learning-provider', () => ({ useLearning: () => learning }))
vi.mock('@/lib/learning/db', () => ({ listFileSnapshots: vi.fn() }))
vi.mock('@/lib/learning/sandbox-recovery', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/learning/sandbox-recovery')>(),
  readSandboxLifecycle: vi.fn(), restoreProjectSandbox: vi.fn(), requestSandboxShutdown: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
vi.mock('@/components/ui/dialog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/dialog')>()
  return {
    ...actual,
    DialogContent: (props: ComponentProps<typeof actual.DialogContent>) => {
      if (learning.failRecoveryRender) throw learning.recoveryRenderError
      return <actual.DialogContent {...props} />
    },
  }
})

beforeEach(() => {
  learning.activeProject = { id: 'project-a', sandboxId: 'sbx_old' }
  learning.failRecoveryRender = false
  learning.recoveryRenderError = new Error('Simulated recovery render failure')
  useSandboxStore.getState().setSandboxId('sbx_old')
  vi.mocked(readSandboxLifecycle).mockResolvedValue({ status: 'stopped' })
})
afterEach(() => { cleanup(); useSandboxStore.getState().clearSandbox(); vi.restoreAllMocks(); vi.resetAllMocks() })

describe('sandbox expiration recovery dialog', () => {
  it.each([null, undefined, 'unexpected provider failure'])('contains non-Error render failures (%s) without losing the draft', async (failure) => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    learning.failRecoveryRender = true
    learning.recoveryRenderError = failure
    render(<><input aria-label="Editor draft" defaultValue="keep this draft" /><SandboxState /></>)
    await screen.findByRole('button', { name: 'Retry sandbox recovery' })
    expect((screen.getByRole('textbox', { name: 'Editor draft' }) as HTMLInputElement).value).toBe('keep this draft')
    expect(errorLog).toHaveBeenCalledWith('Sandbox recovery panel failed', { errorName: 'UnknownError' })
    expect(restoreProjectSandbox).not.toHaveBeenCalled()
    learning.failRecoveryRender = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry sandbox recovery' }))
    await screen.findByRole('dialog', { name: 'Sandbox expired' })
  })

  it.each(['Close', 'Not now', 'Escape'])('returns keyboard focus to Restore after dismissing with %s', async (action) => {
    render(<SandboxState />)
    await screen.findByRole('dialog', { name: 'Sandbox expired' })
    if (action === 'Escape') fireEvent.keyDown(document.activeElement!, { key: 'Escape', code: 'Escape' })
    else fireEvent.click(screen.getByRole('button', { name: action }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const reopen = screen.getByRole('button', { name: 'Sandbox expired · Restore' })
    await waitFor(() => expect(document.activeElement).toBe(reopen))
    expect(restoreProjectSandbox).not.toHaveBeenCalled()
    expect(readSandboxLifecycle).toHaveBeenCalledOnce()
  })

  it('requires reopening instead of another restore after an unconfirmed final save, with a draft guard', async () => {
    vi.mocked(restoreProjectSandbox).mockRejectedValue(new SandboxReopenRequiredError())
    render(<SandboxState />)
    fireEvent.click(await screen.findByRole('button', { name: 'Restore in a new sandbox' }))
    const reopen = await screen.findByRole('button', { name: 'Reopen project' })
    expect(screen.getByRole('alert').textContent).toContain('replacement has not been stopped')
    expect(screen.queryByRole('button', { name: 'Retry restoration' })).toBeNull()
    act(() => useSandboxStore.getState().setDirtyFilePath('main.ts'))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    fireEvent.click(reopen)
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('main.ts'))
    expect(restoreProjectSandbox).toHaveBeenCalledOnce()
    expect(useSandboxStore.getState()).toMatchObject({ sandboxId: 'sbx_old', dirtyFilePath: 'main.ts' })
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sandbox expired · Restore' }))
    expect(screen.getByRole('button', { name: 'Reopen project' })).toBeTruthy()
  })

  it('contains a recovery render failure without discarding the workspace or automatically restoring', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    learning.failRecoveryRender = true
    const state = useSandboxStore.getState()
    state.addPaths(['main.ts'])
    state.setActiveFile('main.ts')
    state.setDirtyFilePath('main.ts')
    render(<><input aria-label="Editor draft" defaultValue="unsaved draft" /><SandboxState /></>)
    await screen.findByRole('button', { name: 'Retry sandbox recovery' })
    expect((screen.getByRole('textbox', { name: 'Editor draft' }) as HTMLInputElement).value).toBe('unsaved draft')
    expect(useSandboxStore.getState()).toMatchObject({ sandboxId: 'sbx_old', paths: ['main.ts'], activeFile: 'main.ts', dirtyFilePath: 'main.ts' })
    expect(restoreProjectSandbox).not.toHaveBeenCalled()
    expect(learning.updateProject).not.toHaveBeenCalled()
    expect(errorLog).toHaveBeenCalledWith('Sandbox recovery panel failed', { errorName: 'Error' })

    learning.failRecoveryRender = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry sandbox recovery' }))
    await screen.findByRole('dialog', { name: 'Sandbox expired' })
    expect(screen.queryByText('Sandbox recovery could not open')).toBeNull()
    expect(restoreProjectSandbox).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect((screen.getByRole('textbox', { name: 'Editor draft' }) as HTMLInputElement).value).toBe('unsaved draft')
  })

  it('does not carry a failed recovery panel into a different project', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    learning.failRecoveryRender = true
    const view = render(<SandboxState />)
    await screen.findByRole('button', { name: 'Retry sandbox recovery' })
    learning.failRecoveryRender = false
    learning.activeProject = { id: 'project-b', sandboxId: 'sbx_new' }
    vi.mocked(readSandboxLifecycle).mockResolvedValue({ status: 'running' })
    act(() => useSandboxStore.getState().setSandboxId('sbx_new'))
    view.rerender(<SandboxState />)
    await waitFor(() => expect(readSandboxLifecycle).toHaveBeenCalledWith('sbx_new', expect.any(AbortSignal)))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(useSandboxStore.getState()).toMatchObject({ sandboxId: 'sbx_new', status: 'running' })
  })

  it('does not loop on a failed status check, and lets the user retry into normal expiration recovery', async () => {
    vi.mocked(readSandboxLifecycle).mockRejectedValueOnce(new Error('Connection unavailable.'))
    render(<SandboxState />)
    fireEvent.click(await screen.findByRole('button', { name: 'Retry connection' }))
    await screen.findByRole('dialog', { name: 'Sandbox expired' })
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    act(() => useSandboxStore.getState().setSandboxStatus('sbx_old', 'stopped'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(readSandboxLifecycle).toHaveBeenCalledTimes(2)
    expect(restoreProjectSandbox).not.toHaveBeenCalled()
  })

  it('does not offer cancellation as a rollback after the project save starts', async () => {
    let signal!: AbortSignal
    vi.mocked(restoreProjectSandbox).mockImplementationOnce((options) => {
      signal = options.signal
      options.onCommitting?.()
      return new Promise(() => {})
    })
    const view = render(<SandboxState />)
    fireEvent.click(await screen.findByRole('button', { name: 'Restore in a new sandbox' }))
    const cancel = screen.getByRole('button', { name: 'Cancel restoration' }) as HTMLButtonElement
    expect(cancel.disabled).toBe(true)
    fireEvent.click(cancel)
    expect(signal.aborted).toBe(false)
    expect((screen.getByRole('button', { name: 'Saving workspace…' }) as HTMLButtonElement).disabled).toBe(true)
    view.unmount()
    expect(signal.aborted).toBe(true)
  })

  it('cancels a stalled restore, waits for cleanup, and permits an explicit retry', async () => {
    let signal!: AbortSignal
    let finishCleanup!: () => void
    vi.mocked(restoreProjectSandbox).mockImplementationOnce((options) => {
      signal = options.signal
      return new Promise((_resolve, reject) => {
        finishCleanup = () => reject(signal.reason)
      })
    }).mockRejectedValueOnce(new Error('Retry reached the server.'))
    render(<SandboxState />)
    fireEvent.click(await screen.findByRole('button', { name: 'Restore in a new sandbox' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel restoration' }))
    expect(signal.aborted).toBe(true)
    expect((screen.getByRole('button', { name: 'Cancelling…' }) as HTMLButtonElement).disabled).toBe(true)
    expect(restoreProjectSandbox).toHaveBeenCalledTimes(1)
    await act(async () => finishCleanup())
    expect(screen.getByRole('alert').textContent).toMatch(/cancelled/i)
    expect(useSandboxStore.getState().sandboxId).toBe('sbx_old')
    fireEvent.click(screen.getByRole('button', { name: 'Retry restoration' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Retry reached the server.'))
    expect(restoreProjectSandbox).toHaveBeenCalledTimes(2)
  })

  it('does not replace an unsaved draft without confirmation', async () => {
    useSandboxStore.getState().setDirtyFilePath('main.ts')
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<SandboxState />)
    fireEvent.click(await screen.findByRole('button', { name: 'Restore in a new sandbox' }))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('main.ts'))
    expect(restoreProjectSandbox).not.toHaveBeenCalled()
    expect(useSandboxStore.getState().dirtyFilePath).toBe('main.ts')
  })

  it('closes without reopening and keeps an accessible restore action', async () => {
    render(<SandboxState />)
    await screen.findByRole('dialog', { name: 'Sandbox expired' })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Sandbox expired · Restore' }))
    expect(screen.getByRole('dialog', { name: 'Sandbox expired' })).toBeTruthy()
    expect(readSandboxLifecycle).toHaveBeenCalledTimes(1)
  })

  it('makes a failed restoration retryable without dismissing the saved workspace', async () => {
    vi.mocked(restoreProjectSandbox).mockRejectedValue(new Error('Snapshot upload failed.'))
    render(<SandboxState />)
    fireEvent.click(await screen.findByRole('button', { name: 'Restore in a new sandbox' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Snapshot upload failed.')
    expect((screen.getByRole('button', { name: 'Retry restoration' }) as HTMLButtonElement).disabled).toBe(false)
    expect(useSandboxStore.getState().sandboxId).toBe('sbx_old')
  })

  it('allows one restore at a time and aborts it on project change', async () => {
    let signal: AbortSignal | undefined
    vi.mocked(restoreProjectSandbox).mockImplementation((options) => {
      signal = options.signal
      return new Promise(() => {})
    })
    const view = render(<SandboxState />)
    const restore = await screen.findByRole('button', { name: 'Restore in a new sandbox' })
    fireEvent.click(restore)
    fireEvent.click(restore)
    expect(restoreProjectSandbox).toHaveBeenCalledTimes(1)
    expect(learning.updateProject).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: 'Restoring…' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
    learning.activeProject = { id: 'project-b', sandboxId: 'sbx_new' }
    act(() => useSandboxStore.getState().setSandboxId('sbx_new'))
    view.rerender(<SandboxState />)
    expect(signal?.aborted).toBe(true)
  })

  it('does not let a late status response stop a replacement sandbox', async () => {
    let finish!: (value: { status: 'stopped' }) => void
    vi.mocked(readSandboxLifecycle).mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    const view = render(<SandboxState />)
    learning.activeProject = { id: 'project-b', sandboxId: 'sbx_new' }
    vi.mocked(readSandboxLifecycle).mockResolvedValue({ status: 'running' })
    act(() => useSandboxStore.getState().setSandboxId('sbx_new'))
    view.rerender(<SandboxState />)
    await act(async () => finish({ status: 'stopped' }))
    expect(useSandboxStore.getState()).toMatchObject({ sandboxId: 'sbx_new', status: 'running' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
