// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ProjectArchiveImport } from '@/components/platform/project-archive-import'
import { ProjectImportedHistory } from '@/components/platform/project-imported-history'
import { acknowledgeArchiveImport, cancelPendingArchiveImport, checkPendingArchiveImport, importProjectArchive, readImportedArchivePage } from '@/lib/learning/archive-import'
import { useSandboxStore } from '@/app/state'

vi.mock('@/lib/learning/archive-import', () => ({ acknowledgeArchiveImport: vi.fn(), cancelPendingArchiveImport: vi.fn(), checkPendingArchiveImport: vi.fn(), importProjectArchive: vi.fn(), readImportedArchivePage: vi.fn(), downloadImportedArchive: vi.fn() }))
const project = { id: '11111111-1111-4111-8111-111111111111', title: 'Imported', language: 'Any', mode: 'playground' as const, status: 'active' as const, createdAt: 0, updatedAt: 0 }
const onOpen = vi.fn(), onClose = vi.fn()
beforeEach(() => { vi.mocked(checkPendingArchiveImport).mockResolvedValue(undefined); useSandboxStore.getState().setDirtyFilePath(undefined) })
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.restoreAllMocks() })
async function choose() {
  await waitFor(() => expect(screen.getByLabelText('Full project archive').hasAttribute('disabled')).toBe(false))
  fireEvent.change(screen.getByLabelText('Full project archive'), { target: { files: [new File(['fixture'], 'test.ndjson')] } })
  fireEvent.click(screen.getByRole('button', { name: 'Import archive' }))
}
it('prefills a prepared device backup but waits for an explicit import click', async () => {
  const file = new File(['fixture'], 'device-backup.ndjson')
  vi.mocked(importProjectArchive).mockResolvedValue(project)
  render(<ProjectArchiveImport initialFile={file} onClose={onClose} onOpen={onOpen} />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Import archive' }).hasAttribute('disabled')).toBe(false))
  expect(screen.getByText('Selected backup: device-backup.ndjson')).toBeTruthy()
  expect(importProjectArchive).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Import archive' }))
  await screen.findByRole('button', { name: 'Open imported project' })
  expect(importProjectArchive).toHaveBeenCalledWith(file, expect.any(AbortSignal), expect.any(Function))
})
it('labels history unverified and retains dirty source until an explicit confirmed switch', async () => {
  useSandboxStore.getState().setDirtyFilePath('draft.ts')
  vi.mocked(importProjectArchive).mockResolvedValue(project)
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  render(<ProjectArchiveImport onClose={onClose} onOpen={onOpen} />)
  expect(screen.getByText(/read-only, unverified evidence/)).toBeTruthy()
  await choose()
  fireEvent.click(await screen.findByRole('button', { name: 'Open imported project' }))
  expect(onOpen).not.toHaveBeenCalled(); expect(useSandboxStore.getState().dirtyFilePath).toBe('draft.ts')
  confirm.mockReturnValue(true)
  fireEvent.click(screen.getByRole('button', { name: 'Open imported project' }))
  expect(onOpen).toHaveBeenCalledWith(project); expect(acknowledgeArchiveImport).toHaveBeenCalledWith(project.id)
  expect(useSandboxStore.getState().dirtyFilePath).toBeUndefined()
})
it('shows recoverable upload failures without discarding drafts', async () => {
  useSandboxStore.getState().setDirtyFilePath('draft.ts')
  vi.mocked(importProjectArchive).mockRejectedValue(new Error('Upload unavailable'))
  render(<ProjectArchiveImport onClose={onClose} onOpen={onOpen} />)
  await choose()
  expect((await screen.findByRole('alert')).textContent).toContain('Upload unavailable')
  expect(screen.getByRole('button', { name: 'Retry / resume archive' })).toBeTruthy()
  expect(onOpen).not.toHaveBeenCalled(); expect(useSandboxStore.getState().dirtyFilePath).toBe('draft.ts')
})
it('can open a committed receipt after reload without uploading again', async () => {
  vi.mocked(checkPendingArchiveImport).mockResolvedValue({ state: 'published', project } as never)
  render(<ProjectArchiveImport onClose={onClose} onOpen={onOpen} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Open imported project' }))
  expect(onOpen).toHaveBeenCalledWith(project); expect(importProjectArchive).not.toHaveBeenCalled()
})
it('aborts work on unmount and ignores a late completion', async () => {
  let finish!: (value: typeof project) => void
  vi.mocked(importProjectArchive).mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const view = render(<ProjectArchiveImport onClose={onClose} onOpen={onOpen} />)
  await choose()
  await waitFor(() => expect(importProjectArchive).toHaveBeenCalledOnce())
  view.unmount()
  expect(vi.mocked(importProjectArchive).mock.calls[0][1].aborted).toBe(true)
  finish(project)
  expect(onOpen).not.toHaveBeenCalled(); expect(acknowledgeArchiveImport).not.toHaveBeenCalled()
})
it('handles cancellation losing the publication race without deleting the project', async () => {
  vi.mocked(cancelPendingArchiveImport).mockResolvedValue({ state: 'published', project } as never)
  render(<ProjectArchiveImport onClose={onClose} onOpen={onOpen} />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel staged archive' }).hasAttribute('disabled')).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel staged archive' }))
  expect(await screen.findByRole('button', { name: 'Open imported project' })).toBeTruthy()
  expect(onOpen).not.toHaveBeenCalled()
})
it('renders foreign tool/HTML records only as bounded text and aborts history on unmount', async () => {
  const raw = JSON.stringify({ kind: 'message', key: 'm', data: { html: '<img src=x onerror=alert(1)>', parts: [{ type: 'tool-runCommand' }], large: 'x'.repeat(20_000) } })
  vi.mocked(readImportedArchivePage).mockResolvedValue({ manifest: { recordCount: 1 }, records: [{ index: 1, record: raw }], nextCursor: null } as never)
  const view = render(<ProjectImportedHistory projectId={project.id} onClose={onClose} />)
  await screen.findByText('message')
  expect(view.container.ownerDocument.querySelectorAll('img')).toHaveLength(0)
  expect(screen.getByText(/Preview truncated/).textContent!.length).toBeLessThan(10_200)
  expect(screen.getByText(/Imported tools never run/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(true)
  view.unmount()
  expect(vi.mocked(readImportedArchivePage).mock.calls[0][2].aborted).toBe(true)
})
