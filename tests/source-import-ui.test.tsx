// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ProjectSourceImport } from '@/components/platform/project-source-import'
import { acknowledgeSourceImport, cancelPendingSourceImport, checkPendingSourceImport, importSourceProject } from '@/lib/learning/source-import'
import { useSandboxStore } from '@/app/state'

vi.mock('@/lib/learning/source-import', () => ({ acknowledgeSourceImport: vi.fn(), cancelPendingSourceImport: vi.fn(), checkPendingSourceImport: vi.fn(), importSourceProject: vi.fn() }))
const project = { id: '11111111-1111-4111-8111-111111111111', title: 'Imported', language: 'Any', mode: 'playground' as const, status: 'active' as const, createdAt: 0, updatedAt: 0 }
const onOpen = vi.fn(), onClose = vi.fn()
beforeEach(() => { vi.mocked(checkPendingSourceImport).mockResolvedValue(undefined); useSandboxStore.getState().setDirtyFilePath(undefined) })
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.restoreAllMocks() })
async function choose() {
  await waitFor(() => expect(screen.getByLabelText('Source project export').hasAttribute('disabled')).toBe(false))
  fireEvent.change(screen.getByLabelText('Source project export'), { target: { files: [{ size: 2, text: async () => '{}' }] } })
  fireEvent.click(screen.getByRole('button', { name: 'Import source' }))
}
it('keeps dirty drafts until an explicit successful project switch', async () => {
  useSandboxStore.getState().setDirtyFilePath('draft.ts')
  vi.mocked(importSourceProject).mockResolvedValue(project)
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  render(<ProjectSourceImport onClose={onClose} onOpen={onOpen} />)
  await choose()
  await screen.findByRole('button', { name: 'Open imported project' })
  expect(useSandboxStore.getState().dirtyFilePath).toBe('draft.ts')
  fireEvent.click(screen.getByRole('button', { name: 'Open imported project' }))
  expect(confirm).toHaveBeenCalledOnce(); expect(onOpen).not.toHaveBeenCalled()
  confirm.mockReturnValue(true)
  fireEvent.click(screen.getByRole('button', { name: 'Open imported project' }))
  expect(onOpen).toHaveBeenCalledWith(project)
  expect(acknowledgeSourceImport).toHaveBeenCalledWith(project.id)
  expect(useSandboxStore.getState().dirtyFilePath).toBeUndefined()
})
it('shows a retryable error without discarding the draft or switching projects', async () => {
  useSandboxStore.getState().setDirtyFilePath('draft.ts')
  vi.mocked(importSourceProject).mockRejectedValue(new Error('Upload unavailable'))
  render(<ProjectSourceImport onClose={onClose} onOpen={onOpen} />)
  await choose()
  expect((await screen.findByRole('alert')).textContent).toContain('Upload unavailable')
  expect(screen.getByRole('button', { name: 'Retry / resume import' })).toBeTruthy()
  expect(onOpen).not.toHaveBeenCalled(); expect(useSandboxStore.getState().dirtyFilePath).toBe('draft.ts')
})
it('restores a published receipt after reload without a second upload', async () => {
  vi.mocked(checkPendingSourceImport).mockResolvedValue({ state: 'published', project } as never)
  render(<ProjectSourceImport onClose={onClose} onOpen={onOpen} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Open imported project' }))
  expect(onOpen).toHaveBeenCalledWith(project)
  expect(importSourceProject).not.toHaveBeenCalled()
})
it('late import completion after unmount never opens a project', async () => {
  let finish!: (value: typeof project) => void
  vi.mocked(importSourceProject).mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const view = render(<ProjectSourceImport onClose={onClose} onOpen={onOpen} />)
  await choose()
  await waitFor(() => expect(importSourceProject).toHaveBeenCalledOnce())
  const signal = vi.mocked(importSourceProject).mock.calls[0][1]
  view.unmount(); expect(signal.aborted).toBe(true)
  finish(project)
  expect(onOpen).not.toHaveBeenCalled(); expect(acknowledgeSourceImport).not.toHaveBeenCalled()
})
it('cancellation that finds a committed project offers Open rather than deleting it', async () => {
  vi.mocked(cancelPendingSourceImport).mockResolvedValue({ state: 'published', project } as never)
  render(<ProjectSourceImport onClose={onClose} onOpen={onOpen} />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel staged import' }).hasAttribute('disabled')).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel staged import' }))
  expect(await screen.findByRole('button', { name: 'Open imported project' })).toBeTruthy()
  expect(onOpen).not.toHaveBeenCalled()
})
