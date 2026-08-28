// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { ProjectSwitcher } from '@/components/platform/project-switcher'

const mocks = vi.hoisted(() => ({ checkPending: vi.fn(), acknowledge: vi.fn(), open: vi.fn(),
  project: { id: 'a', title: 'Original project', mode: 'playground' },
}))
vi.mock('@/lib/learning/learning-provider', () => ({ useLearning: () => ({ activeProject: mocks.project, projects: [mocks.project], openImportedProject: mocks.open }) }))
vi.mock('@/lib/learning/source-import', () => ({ checkPendingSourceImport: mocks.checkPending, acknowledgeSourceImport: mocks.acknowledge }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('next/dynamic', () => ({ default: () => () => null }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
beforeEach(() => { mocks.project = { id: 'a', title: 'Original project', mode: 'playground' }; mocks.checkPending.mockResolvedValue(undefined) })
afterEach(() => { cleanup(); vi.resetAllMocks() })

it('returns keyboard focus to the project switcher after closing source import', async () => {
  render(<ProjectSwitcher />)
  const trigger = screen.getByRole('button', { name: 'Original project' })
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('button', { name: 'Import source' }))
  await waitFor(() => expect((screen.getByLabelText('Source project export') as HTMLInputElement).disabled).toBe(false))
  fireEvent.click(screen.getAllByRole('button', { name: 'Close' }).find(button => button.getAttribute('data-slot') === 'button')!)
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await waitFor(() => expect(document.activeElement).toBe(trigger))
})

it('hands focus to the imported project after its workspace remounts', async () => {
  const imported = { id: 'b', title: 'Recovered project', mode: 'playground' }
  mocks.checkPending.mockResolvedValue({ state: 'published', project: imported })
  function Scope() {
    const [id, setId] = useState('a')
    mocks.open.mockImplementation(() => { mocks.project = imported; setId('b') })
    return <ProjectSwitcher key={id} />
  }
  render(<Scope />)
  fireEvent.click(screen.getByRole('button', { name: 'Original project' }))
  fireEvent.click(screen.getByRole('button', { name: 'Import source' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Open imported project' }))
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Recovered project' })))
})
