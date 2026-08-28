// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectSandboxSync } from '@/components/learning/snapshot-observer'
import { useSandboxStore } from '@/app/state'
import { listFileSnapshots } from '@/lib/learning/db'
import { ProjectWorkspaceRegistry } from '@/lib/workspace/project-registry'

const learning = vi.hoisted(() => ({ activeProject: {
  id: 'project-a', sandboxId: 'sbx_a', previewUrl: undefined as string | undefined,
} }))
vi.mock('@/lib/learning/learning-provider', () => ({ useLearning: () => learning }))
vi.mock('@/lib/learning/db', () => ({ listFileSnapshots: vi.fn() }))

const files = (projectId: string, path: string) => [{ id: `${projectId}:${path}`, projectId, path, content: 'saved source', size: 12, updatedAt: 1 }]

beforeEach(() => {
  learning.activeProject = { id: 'project-a', sandboxId: 'sbx_a', previewUrl: undefined }
  vi.mocked(listFileSnapshots).mockResolvedValue(files('project-a', 'app/page.tsx'))
})
afterEach(() => { cleanup(); useSandboxStore.getState().clearSandbox(); vi.restoreAllMocks(); vi.resetAllMocks() })

describe('saved workspace hydration', () => {
  it('hydrates a retained replacement without an older project receipt reattaching the retired sandbox', async () => {
    const registry = new ProjectWorkspaceRegistry()
    const disconnect = registry.connect(new AbortController().signal)
    registry.activate(learning.activeProject)
    registry.apply('project-a', { type: 'data-create-sandbox', id: 'new-vm', data: { sandboxId: 'sbx_replacement', status: 'done' } })
    registry.apply('project-a', { type: 'data-generating-files', id: 'new-files', data: { sandboxId: 'sbx_replacement', paths: ['new.ts'], status: 'done' } })
    try {
      render(<ProjectSandboxSync />)
      await waitFor(() => expect(useSandboxStore.getState().paths).toEqual(['new.ts', 'app/page.tsx']))
      expect(useSandboxStore.getState().sandboxId).toBe('sbx_replacement')
      expect(listFileSnapshots).toHaveBeenCalledOnce()
    } finally { cleanup(); disconnect() }
  })

  it('loads paths in Strict Mode even after its initial effect attached the sandbox', async () => {
    render(<StrictMode><ProjectSandboxSync /></StrictMode>)
    await waitFor(() => expect(useSandboxStore.getState().paths).toEqual(['app/page.tsx']))
    expect(listFileSnapshots).toHaveBeenCalledExactlyOnceWith('project-a', expect.any(AbortSignal))
  })

  it('hydrates an already-attached replacement without resetting drafts or commands', async () => {
    const state = useSandboxStore.getState()
    state.setSandboxId('sbx_a')
    state.addPaths(['new.ts'])
    state.setDirtyFilePath('new.ts')
    state.setActiveFile('new.ts')
    state.upsertCommand({ sandboxId: 'sbx_a', cmdId: 'cmd_1', command: 'node', args: [], status: 'running' })
    render(<ProjectSandboxSync />)
    await waitFor(() => expect(useSandboxStore.getState().paths).toEqual(['new.ts', 'app/page.tsx']))
    expect(useSandboxStore.getState()).toMatchObject({ activeFile: 'new.ts', dirtyFilePath: 'new.ts', commands: [{ cmdId: 'cmd_1' }] })
  })

  it('preserves expiration while loading saved source paths and ignores the old preview', async () => {
    useSandboxStore.getState().setSandboxId('sbx_a')
    useSandboxStore.getState().setSandboxStatus('sbx_a', 'stopped')
    learning.activeProject.previewUrl = 'https://old.vercel.run'
    render(<ProjectSandboxSync />)
    await waitFor(() => expect(useSandboxStore.getState().paths).toEqual(['app/page.tsx']))
    expect(useSandboxStore.getState()).toMatchObject({ status: 'stopped', url: undefined })
  })

  it('restores the active server-provided preview without repeating file reads', async () => {
    const view = render(<ProjectSandboxSync />)
    await waitFor(() => expect(useSandboxStore.getState().paths).toEqual(['app/page.tsx']))
    learning.activeProject.previewUrl = 'https://active.vercel.run'
    view.rerender(<ProjectSandboxSync />)
    expect(useSandboxStore.getState().url).toBe('https://active.vercel.run')
    expect(listFileSnapshots).toHaveBeenCalledTimes(1)
  })

  it('does not let late paths leak into a different project', async () => {
    let finish!: (value: Awaited<ReturnType<typeof listFileSnapshots>>) => void
    vi.mocked(listFileSnapshots).mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
      .mockResolvedValueOnce(files('project-b', 'b.ts'))
    const view = render(<ProjectSandboxSync />)
    await act(async () => {})
    learning.activeProject = { id: 'project-b', sandboxId: 'sbx_b', previewUrl: undefined }
    view.rerender(<ProjectSandboxSync />)
    await waitFor(() => expect(useSandboxStore.getState().paths).toEqual(['b.ts']))
    await act(async () => finish(files('project-a', 'a.ts')))
    expect(useSandboxStore.getState().paths).toEqual(['b.ts'])
  })

  it('cancels the underlying source load when its workspace is unmounted', async () => {
    vi.mocked(listFileSnapshots).mockReturnValue(new Promise(() => {}))
    const view = render(<ProjectSandboxSync />)
    await waitFor(() => expect(listFileSnapshots).toHaveBeenCalledOnce())
    view.unmount()
    expect(vi.mocked(listFileSnapshots).mock.calls[0][1]?.aborted).toBe(true)
  })

  it('offers explicit retry on source read failure without crashing or clearing existing paths', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(listFileSnapshots).mockRejectedValueOnce(new Error('Unavailable'))
    useSandboxStore.getState().setSandboxId('sbx_a')
    useSandboxStore.getState().addPaths(['unsaved.ts'])
    render(<ProjectSandboxSync />)
    fireEvent.click(await screen.findByRole('button', { name: 'Retry loading files' }))
    await waitFor(() => expect(useSandboxStore.getState().paths).toEqual(['unsaved.ts', 'app/page.tsx']))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(listFileSnapshots).toHaveBeenCalledTimes(2)
  })
})
