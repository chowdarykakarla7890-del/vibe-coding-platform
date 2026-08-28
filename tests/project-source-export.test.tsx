// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProjectSwitcher } from '@/components/platform/project-switcher'
import { useSandboxStore } from '@/app/state'

const learning = vi.hoisted(() => ({
  activeProject: { id: 'a', title: 'Saved project', mode: 'playground' },
  projects: [{ id: 'a', title: 'Saved project', mode: 'playground' }],
  exportProject: vi.fn(),
}))
vi.mock('@/lib/learning/learning-provider', () => ({ useLearning: () => learning }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('next/dynamic', () => ({ default: () => () => null }))
vi.mock('@/components/platform/project-archive-export', () => ({ ProjectArchiveExport: () => null }))
vi.mock('@/components/platform/project-source-import', () => ({ ProjectSourceImport: () => null }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
beforeEach(() => {
  learning.activeProject = { id: 'a', title: 'Saved project', mode: 'playground' }
  useSandboxStore.getState().setDirtyFilePath(undefined)
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn(() => 'blob:export-fixture')
    static revokeObjectURL = vi.fn()
  })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals() })
function openMenu() { fireEvent.click(screen.getByRole('button', { name: learning.activeProject.title })) }

it('blocks source export while preserving an unsaved draft', () => {
  useSandboxStore.getState().setDirtyFilePath('draft.ts')
  render(<ProjectSwitcher />); openMenu()
  const button = screen.getByRole('button', { name: 'Source export' }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  expect(button.title).toMatch(/save.*draft/i)
  fireEvent.click(button)
  expect(learning.exportProject).not.toHaveBeenCalled()
  expect(useSandboxStore.getState().dirtyFilePath).toBe('draft.ts')
})

it.each(['unmount', 'project change'])('aborts an obsolete source export on %s and ignores a late result', async reason => {
  const pending = Promise.withResolvers<object>()
  learning.exportProject.mockReturnValue(pending.promise)
  const view = render(<ProjectSwitcher />); openMenu()
  fireEvent.click(screen.getByRole('button', { name: 'Source export' }))
  const signal = learning.exportProject.mock.calls[0][1] as AbortSignal
  if (reason === 'unmount') view.unmount()
  else { learning.activeProject = { id: 'b', title: 'Other project', mode: 'playground' }; view.rerender(<ProjectSwitcher />) }
  expect(signal?.aborted).toBe(true)
  await act(async () => pending.resolve({ version: 1, files: [] }))
  expect(URL.createObjectURL).not.toHaveBeenCalled()
})

it('does not download a stale saved-only copy if the learner starts editing during export', async () => {
  const pending = Promise.withResolvers<object>()
  learning.exportProject.mockReturnValue(pending.promise)
  render(<ProjectSwitcher />); openMenu()
  fireEvent.click(screen.getByRole('button', { name: 'Source export' }))
  act(() => useSandboxStore.getState().setDirtyFilePath('draft.ts'))
  await act(async () => pending.resolve({ version: 1, files: [] }))
  expect(URL.createObjectURL).not.toHaveBeenCalled()
  expect(useSandboxStore.getState().dirtyFilePath).toBe('draft.ts')
})

it('keeps the completed download URL alive long enough for the browser to consume it', async () => {
  learning.exportProject.mockResolvedValue({ version: 1, files: [] })
  render(<ProjectSwitcher />); openMenu()
  vi.useFakeTimers()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Source export' })))
  expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce()
  expect(URL.revokeObjectURL).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(59_999)
  expect(URL.revokeObjectURL).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:export-fixture')
})
