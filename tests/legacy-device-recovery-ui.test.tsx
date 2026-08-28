// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProjectLegacyRecovery } from '@/components/platform/project-legacy-recovery'
import { listLegacyProjects } from '@/lib/learning/legacy-device-db'
import { prepareLegacyArchive, type LegacyArchive } from '@/lib/learning/legacy-device-archive'
import { setCloudAccount } from '@/lib/learning/cloud-request'
import { useSandboxStore } from '@/app/state'

const identity = vi.hoisted(() => ({ userId: '11111111-1111-4111-8111-111111111111', email: 'owner@example.invalid' }))
vi.mock('@/components/auth/user-workspace', () => ({ useWorkspaceAccount: () => ({ ...identity }) }))
vi.mock('@/lib/learning/legacy-device-db', () => ({ listLegacyProjects: vi.fn() }))
vi.mock('@/lib/learning/legacy-device-archive', () => ({ prepareLegacyArchive: vi.fn() }))
const onClose = vi.fn(), onContinue = vi.fn()
const page = { projects: [{ id: 'local-a', title: 'Device A', language: 'Python', readable: true }], nextCursor: null }
const backup = { blob: new Blob(['verified archive']), title: 'Device A', fileCount: 2, messageCount: 305, attemptCount: 4 } as LegacyArchive
beforeEach(() => {
  identity.userId = '11111111-1111-4111-8111-111111111111'; identity.email = 'owner@example.invalid'
  setCloudAccount(identity.userId)
  vi.mocked(listLegacyProjects).mockResolvedValue(page)
  vi.mocked(prepareLegacyArchive).mockResolvedValue(backup)
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network before consent') }))
})
afterEach(() => { cleanup(); useSandboxStore.getState().clearSandbox(); setCloudAccount(undefined); vi.resetAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function prepare() {
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Device project' }).hasAttribute('disabled')).toBe(false))
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'local-a' } })
  fireEvent.click(screen.getByRole('button', { name: 'Prepare local backup' }))
  await screen.findByText('2 source files · 305 messages · 4 attempts')
}
it('requires account consent before handing off a prepared file, with no automatic upload or draft loss', async () => {
  useSandboxStore.getState().setDirtyFilePath('draft.ts')
  render(<StrictMode><ProjectLegacyRecovery onClose={onClose} onContinue={onContinue} /></StrictMode>)
  await prepare()
  const proceed = screen.getByRole('button', { name: 'Continue to account import' })
  expect(proceed.hasAttribute('disabled')).toBe(true)
  fireEvent.click(proceed)
  expect(onContinue).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('checkbox', { name: /copy it to owner@example.invalid/ }))
  fireEvent.click(proceed)
  expect(onContinue).toHaveBeenCalledOnce()
  expect(onContinue.mock.calls[0][0]).toBeInstanceOf(File)
  expect(onContinue.mock.calls[0][0].name).toBe('Device-A.device-backup.ndjson')
  expect(fetch).not.toHaveBeenCalled()
  expect(useSandboxStore.getState().dirtyFilePath).toBe('draft.ts')
})
it('offers a local backup without requiring cloud-upload consent', async () => {
  const create = vi.fn(() => 'blob:local-backup'), revoke = vi.fn()
  vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = revoke })
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  render(<ProjectLegacyRecovery onClose={onClose} onContinue={onContinue} />)
  await prepare()
  fireEvent.click(screen.getByRole('button', { name: 'Download device backup' }))
  expect(create).toHaveBeenCalledWith(backup.blob)
  expect(click).toHaveBeenCalledOnce()
  expect(onContinue).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
  expect(screen.getByText(/not a general secret scanner/)).toBeTruthy()
})
it('rejects a changed account even if the old consent remains on screen', async () => {
  render(<ProjectLegacyRecovery onClose={onClose} onContinue={onContinue} />)
  await prepare()
  fireEvent.click(screen.getByRole('checkbox'))
  setCloudAccount('22222222-2222-4222-8222-222222222222')
  fireEvent.click(screen.getByRole('button', { name: 'Continue to account import' }))
  expect(screen.getByRole('alert').textContent).toContain('account changed')
  expect(onContinue).not.toHaveBeenCalled()
})
it('clears prepared data and consent when the workspace account changes', async () => {
  const view = render(<ProjectLegacyRecovery onClose={onClose} onContinue={onContinue} />)
  await prepare(); fireEvent.click(screen.getByRole('checkbox'))
  identity.userId = '22222222-2222-4222-8222-222222222222'; identity.email = 'next@example.invalid'
  setCloudAccount(identity.userId)
  view.rerender(<ProjectLegacyRecovery onClose={onClose} onContinue={onContinue} />)
  await waitFor(() => expect(screen.getByRole('combobox').hasAttribute('disabled')).toBe(false))
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(screen.queryByText('2 source files · 305 messages · 4 attempts')).toBeNull()
  expect(onContinue).not.toHaveBeenCalled()
})
it('aborts preparation on close and ignores late completion after unmount', async () => {
  let finish!: (value: LegacyArchive) => void
  vi.mocked(prepareLegacyArchive).mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const view = render(<ProjectLegacyRecovery onClose={onClose} onContinue={onContinue} />)
  await waitFor(() => expect(screen.getByRole('combobox').hasAttribute('disabled')).toBe(false))
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'local-a' } })
  fireEvent.click(screen.getByRole('button', { name: 'Prepare local backup' }))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel recovery' }))
  expect(vi.mocked(prepareLegacyArchive).mock.calls[0][1].aborted).toBe(true)
  expect(onClose).toHaveBeenCalledOnce()
  view.unmount(); await act(async () => finish(backup))
  expect(onContinue).not.toHaveBeenCalled()
})
it('shows storage errors with explicit retry instead of an empty-device success', async () => {
  vi.mocked(listLegacyProjects).mockRejectedValueOnce(new Error('Storage is blocked'))
  render(<ProjectLegacyRecovery onClose={onClose} onContinue={onContinue} />)
  expect((await screen.findByRole('alert')).textContent).toBe('Storage is blocked')
  expect(screen.queryByText('No earlier device projects were found here.')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Retry device scan' }))
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  expect(listLegacyProjects).toHaveBeenCalledTimes(2)
})
it('does not auto-prepare unreadable device records', async () => {
  vi.mocked(listLegacyProjects).mockResolvedValue({ projects: [{ ...page.projects[0], readable: false }], nextCursor: null })
  render(<ProjectLegacyRecovery onClose={onClose} onContinue={onContinue} />)
  await screen.findByText(/unreadable project was found/)
  const option = screen.getByRole('option', { name: /cannot prepare automatically/ })
  expect(option.hasAttribute('disabled')).toBe(true)
  expect(prepareLegacyArchive).not.toHaveBeenCalled()
})
