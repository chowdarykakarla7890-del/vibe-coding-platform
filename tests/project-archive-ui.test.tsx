// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProjectArchiveExport } from '@/components/platform/project-archive-export'
import { downloadProjectArchive } from '@/lib/learning/project-archive'
import { useSandboxStore } from '@/app/state'

vi.mock('@/lib/learning/project-archive', () => ({ downloadProjectArchive: vi.fn() }))
const projectId = '11111111-1111-4111-8111-111111111111'
beforeEach(() => { useSandboxStore.getState().clearSandbox(); vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:fixture'), revokeObjectURL: vi.fn() }) })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals() })
it('blocks export of an unsaved draft and explains how to retain original imported evidence', () => {
  useSandboxStore.getState().setDirtyFilePath('main.ts')
  render(<ProjectArchiveExport projectId={projectId} title="Fixture" onClose={vi.fn()} />)
  expect((screen.getByRole('button', { name: 'Download archive' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText(/Restore this NDJSON file with Import archive/)).toBeTruthy()
  expect(screen.getByText(/earlier imported history in one file/)).toBeTruthy()
})
it('prevents double export and reports verified progress', async () => {
  const deferred = Promise.withResolvers<Blob>()
  vi.mocked(downloadProjectArchive).mockImplementation(async (_id, _signal, progress) => { progress(2, 10); return deferred.promise })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  render(<ProjectArchiveExport projectId={projectId} title="Fixture" onClose={vi.fn()} />)
  const button = screen.getByRole('button', { name: 'Download archive' })
  fireEvent.click(button); fireEvent.click(button)
  expect(downloadProjectArchive).toHaveBeenCalledOnce()
  expect(screen.getByText('Verified 2 of 10 records…')).toBeTruthy()
  await act(async () => deferred.resolve(new Blob(['verified'])))
  expect(screen.getByText('Archive verified. Download started.')).toBeTruthy()
})
it('offers explicit retry after failure', async () => {
  vi.mocked(downloadProjectArchive).mockRejectedValue(new Error('Archive interrupted'))
  render(<ProjectArchiveExport projectId={projectId} title="Fixture" onClose={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Download archive' }))
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: 'Retry export' }))
  await waitFor(() => expect(downloadProjectArchive).toHaveBeenCalledTimes(2))
})
it('aborts on unmount and ignores a late Blob', async () => {
  const deferred = Promise.withResolvers<Blob>()
  let signal!: AbortSignal
  vi.mocked(downloadProjectArchive).mockImplementation(async (_id, supplied) => { signal = supplied; return deferred.promise })
  const view = render(<ProjectArchiveExport projectId={projectId} title="Fixture" onClose={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Download archive' }))
  view.unmount(); expect(signal.aborted).toBe(true)
  await act(async () => deferred.resolve(new Blob(['obsolete'])))
  expect(URL.createObjectURL).not.toHaveBeenCalled()
})
