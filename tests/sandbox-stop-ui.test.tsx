// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SandboxStop } from '@/components/workspace/sandbox-stop'
import { SandboxState } from '@/components/modals/sandbox-state'
import { useSandboxStore } from '@/app/state'
import { readSandboxLifecycle, requestSandboxShutdown } from '@/lib/learning/sandbox-recovery'
import { toast } from 'sonner'
import { StrictMode } from 'react'

const learning = vi.hoisted(() => ({ activeProject: { id: 'project-a', sandboxId: 'sandbox-a' }, updateProject: vi.fn() }))
vi.mock('@/lib/learning/learning-provider', () => ({ useLearning: () => learning }))
vi.mock('@/lib/learning/db', () => ({ listFileSnapshots: vi.fn() }))
vi.mock('@/lib/learning/sandbox-recovery', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/learning/sandbox-recovery')>(),
  readSandboxLifecycle: vi.fn(), requestSandboxShutdown: vi.fn(), restoreProjectSandbox: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
const receipt = { jobId: '11111111-1111-4111-8111-111111111111', state: 'saving' as const, saved: false, hasConflicts: false }

beforeEach(() => {
  useSandboxStore.getState().setSandboxId('sandbox-a')
  learning.activeProject = { id: 'project-a', sandboxId: 'sandbox-a' }
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  vi.mocked(requestSandboxShutdown).mockResolvedValue({ status: 'stopping', shutdown: receipt })
})
afterEach(() => { cleanup(); useSandboxStore.getState().clearSandbox(); vi.restoreAllMocks(); vi.resetAllMocks() })

it('requires saving a dirty draft before requesting shutdown', () => {
  useSandboxStore.getState().setDirtyFilePath('main.ts')
  render(<SandboxStop />)
  fireEvent.click(screen.getByRole('button', { name: 'Stop sandbox' }))
  expect(requestSandboxShutdown).not.toHaveBeenCalled()
  expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('unsaved editor draft'))
  expect(useSandboxStore.getState().dirtyFilePath).toBe('main.ts')
})

it('does not request shutdown if confirmation is declined', () => {
  vi.mocked(window.confirm).mockReturnValue(false)
  render(<SandboxStop />)
  fireEvent.click(screen.getByRole('button', { name: 'Stop sandbox' }))
  expect(requestSandboxShutdown).not.toHaveBeenCalled()
})

it('makes one confirmed request and preserves source paths while saving', async () => {
  useSandboxStore.getState().addPaths(['main.ts'])
  render(<SandboxStop />)
  const button = screen.getByRole('button', { name: 'Stop sandbox' })
  fireEvent.click(button); fireEvent.click(button)
  await waitFor(() => expect(useSandboxStore.getState().status).toBe('stopping'))
  expect(requestSandboxShutdown).toHaveBeenCalledOnce()
  expect(useSandboxStore.getState().paths).toEqual(['main.ts'])
})

it('does not show Restore for a retryable shutdown or discard a mounted draft', async () => {
  vi.mocked(readSandboxLifecycle).mockResolvedValue({ status: 'stopping', shutdown: { ...receipt, state: 'retryable' } })
  render(<><input aria-label="Draft" defaultValue="unsaved source" /><SandboxState /></>)
  const button = await screen.findByRole('button', { name: 'Retry save and shutdown' })
  expect(screen.queryByRole('button', { name: 'Restore in a new sandbox' })).toBeNull()
  vi.mocked(readSandboxLifecycle).mockResolvedValue({ status: 'stopping', shutdown: receipt })
  fireEvent.click(button)
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry save and shutdown' })).toBeNull())
  expect(requestSandboxShutdown).toHaveBeenCalledOnce()
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('unsaved source')
})

it('distinguishes saved shutdown from expiration and warns about conflicting copies', async () => {
  vi.mocked(readSandboxLifecycle).mockResolvedValue({ status: 'stopped', shutdown: { ...receipt, state: 'saved', saved: true, hasConflicts: true } })
  render(<SandboxState />)
  await screen.findByRole('dialog', { name: 'Sandbox stopped' })
  expect(screen.getByText(/Conflicting source versions were preserved/)).toBeTruthy()
  expect(screen.getByText(/Final source was saved before shutdown/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
  fireEvent.click(screen.getByRole('button', { name: 'Sandbox stopped · Restore' }))
  expect(screen.getByRole('dialog', { name: 'Sandbox stopped' })).toBeTruthy()
})

it('warns honestly when the VM expired before a final save', async () => {
  vi.mocked(readSandboxLifecycle).mockResolvedValue({ status: 'stopped', shutdown: { ...receipt, state: 'incomplete' } })
  render(<SandboxState />)
  await screen.findByRole('dialog', { name: 'Sandbox expired' })
  expect(screen.getByText(/unsaved terminal changes may be missing/)).toBeTruthy()
})

it('checks final-save details once even if the sandbox was already marked stopped', async () => {
  useSandboxStore.getState().setSandboxStatus('sandbox-a', 'stopped')
  vi.mocked(readSandboxLifecycle).mockResolvedValue({ status: 'stopped', shutdown: { ...receipt, state: 'saved', saved: true, hasConflicts: true } })
  render(<StrictMode><SandboxState /></StrictMode>)
  await screen.findByRole('dialog', { name: 'Sandbox stopped' })
  expect(screen.getByText(/Conflicting source versions were preserved/)).toBeTruthy()
  const reads = vi.mocked(readSandboxLifecycle).mock.calls.length
  expect(reads).toBeGreaterThan(0)
  fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
  fireEvent.click(screen.getByRole('button', { name: 'Sandbox stopped · Restore' }))
  await act(async () => {})
  expect(readSandboxLifecycle).toHaveBeenCalledTimes(reads)
})

it('shows a failed final-status check inside the stopped dialog and retries explicitly', async () => {
  useSandboxStore.getState().setSandboxStatus('sandbox-a', 'stopped')
  vi.mocked(readSandboxLifecycle).mockRejectedValueOnce(new Error('Final save status unavailable.'))
    .mockResolvedValueOnce({ status: 'stopped', shutdown: { ...receipt, state: 'incomplete' } })
  render(<SandboxState />)
  const retry = await screen.findByRole('button', { name: 'Retry status check' })
  expect(screen.getByRole('alert').textContent).toBe('Final save status unavailable.')
  expect(screen.getByRole('button', { name: 'Restore in a new sandbox' })).toBeTruthy()
  expect(readSandboxLifecycle).toHaveBeenCalledTimes(1)
  fireEvent.click(retry)
  await screen.findByText(/unsaved terminal changes may be missing/)
  expect(screen.queryByRole('button', { name: 'Retry status check' })).toBeNull()
  expect(readSandboxLifecycle).toHaveBeenCalledTimes(2)
})

it('does not reopen command access when a stopped sandbox returns a stale running status', async () => {
  useSandboxStore.getState().setSandboxStatus('sandbox-a', 'stopped')
  vi.mocked(readSandboxLifecycle).mockResolvedValueOnce({ status: 'running' })
    .mockResolvedValueOnce({ status: 'stopped' })
  render(<SandboxState />)
  fireEvent.click(await screen.findByRole('button', { name: 'Retry status check' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry status check' })).toBeNull())
  expect(useSandboxStore.getState().status).toBe('stopped')
  expect(screen.getByRole('dialog', { name: 'Sandbox expired' })).toBeTruthy()
  expect(readSandboxLifecycle).toHaveBeenCalledTimes(2)
})

it('keeps shutdown controls visible when a delayed status claims the VM is still running', async () => {
  useSandboxStore.getState().setSandboxStatus('sandbox-a', 'stopping')
  vi.mocked(readSandboxLifecycle).mockResolvedValueOnce({ status: 'running' })
    .mockResolvedValueOnce({ status: 'stopped', shutdown: { ...receipt, state: 'saved', saved: true } })
  render(<SandboxState />)
  const retry = await screen.findByRole('button', { name: 'Retry connection' })
  expect(useSandboxStore.getState().status).toBe('stopping')
  expect(screen.getByText('Saving final source before shutdown…')).toBeTruthy()
  expect(readSandboxLifecycle).toHaveBeenCalledTimes(1)
  fireEvent.click(retry)
  await screen.findByRole('dialog', { name: 'Sandbox stopped' })
  expect(useSandboxStore.getState().status).toBe('stopped')
})

it('aborts the browser wait on project change without changing the new workspace', async () => {
  let resolve!: (value: Awaited<ReturnType<typeof requestSandboxShutdown>>) => void
  let signal!: AbortSignal
  vi.mocked(requestSandboxShutdown).mockImplementation((_id, nextSignal) => { signal = nextSignal; return new Promise(r => { resolve = r }) })
  const view = render(<SandboxStop />)
  fireEvent.click(screen.getByRole('button', { name: 'Stop sandbox' }))
  learning.activeProject = { id: 'project-b', sandboxId: 'sandbox-b' }
  act(() => useSandboxStore.getState().setSandboxId('sandbox-b'))
  view.rerender(<SandboxStop />)
  expect(signal.aborted).toBe(true)
  await act(async () => resolve({ status: 'stopping', shutdown: receipt }))
  expect(useSandboxStore.getState()).toMatchObject({ sandboxId: 'sandbox-b', status: 'running' })
})
