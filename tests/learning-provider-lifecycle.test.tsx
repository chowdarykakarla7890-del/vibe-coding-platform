// @vitest-environment jsdom
import { useEffect } from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LearningProvider, useLearning } from '@/lib/learning/learning-provider'
import { setCloudAccount } from '@/lib/learning/cloud-request'
import { loadWorkspaceHistory } from '@/lib/learning/load-history'
import { createProject, saveProject } from '@/lib/learning/db'

vi.mock('@/lib/learning/load-history', () => ({ loadWorkspaceHistory: vi.fn() }))
vi.mock('@/lib/learning/db', () => ({ createProject: vi.fn(), saveProject: vi.fn(), listProgress: vi.fn(),
  exportProject: vi.fn(), importProject: vi.fn(), removeProject: vi.fn() }))
vi.mock('@/lib/local-preferences', () => ({ readLocalPreference: () => null, writeLocalPreference: vi.fn() }))
const project = { id: '22222222-2222-4222-8222-222222222222', title: 'Original', mode: 'playground' as const,
  language: 'Any', status: 'active' as const, createdAt: 1, updatedAt: 1 }
let learning: ReturnType<typeof useLearning>
function Probe() { const context = useLearning(); useEffect(() => { learning = context }, [context]); return null }
async function mount() {
  render(<LearningProvider><Probe /></LearningProvider>)
  await waitFor(() => expect(learning?.activeProject?.id).toBe(project.id))
}
beforeEach(() => {
  setCloudAccount('11111111-1111-4111-8111-111111111111')
  vi.mocked(loadWorkspaceHistory).mockResolvedValue([[project], []])
})
afterEach(() => { cleanup(); setCloudAccount(undefined); vi.resetAllMocks(); learning = undefined as unknown as ReturnType<typeof useLearning> })

it('binds queued project writes to the original account instead of borrowing the next login', async () => {
  await mount()
  let finish!: (value: typeof project) => void
  vi.mocked(saveProject).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const first = learning.updateProject(project.id, { title: 'First' })
  const second = learning.updateProject(project.id, { title: 'Second' })
  const settled = Promise.allSettled([first, second])
  await waitFor(() => expect(saveProject).toHaveBeenCalledOnce())
  setCloudAccount('33333333-3333-4333-8333-333333333333')
  await act(async () => { finish({ ...project, title: 'First' }); await settled })
  expect((await settled).map(result => result.status)).toEqual(['rejected', 'rejected'])
  expect(saveProject).toHaveBeenCalledOnce()
  expect(vi.mocked(saveProject).mock.calls[0][1]?.aborted).toBe(true)
  expect(learning.activeProject?.title).toBe('Original')
})
it('does not publish a cancelled queued settings update, and a later intentional update can proceed', async () => {
  await mount()
  let finish!: (value: typeof project) => void
  vi.mocked(saveProject).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockImplementationOnce(async value => value)
  const first = learning.updateProject(project.id, { title: 'First' })
  const controller = new AbortController()
  const cancelled = learning.updateProject(project.id, { language: 'Java' }, controller.signal)
  const settled = Promise.allSettled([first, cancelled])
  await waitFor(() => expect(saveProject).toHaveBeenCalledOnce())
  controller.abort()
  await act(async () => { finish({ ...project, title: 'First' }); await settled })
  expect((await settled).map(result => result.status)).toEqual(['fulfilled', 'rejected'])
  expect(saveProject).toHaveBeenCalledOnce()
  await act(async () => { await learning.updateProject(project.id, { title: 'Final' }) })
  expect(learning.activeProject?.title).toBe('Final')
  expect(learning.activeProject?.language).toBe('Any')
})
it.each(['navigation', 'account'] as const)('does not select a newly created project after %s cancellation', async reason => {
  await mount()
  let finish!: (value: typeof project) => void
  vi.mocked(createProject).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const controller = new AbortController()
  const pending = learning.createProject({ title: 'Late' }, controller.signal).then(() => 'success', () => 'cancelled')
  if (reason === 'navigation') controller.abort()
  else setCloudAccount('33333333-3333-4333-8333-333333333333')
  await act(async () => { finish({ ...project, id: crypto.randomUUID(), title: 'Late' }); await pending })
  expect(await pending).toBe('cancelled')
  expect(learning.activeProject?.id).toBe(project.id)
  expect(learning.projects).toHaveLength(1)
})
