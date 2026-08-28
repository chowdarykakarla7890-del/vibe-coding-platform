// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProjectSwitcher } from '@/components/platform/project-switcher'
import { useState } from 'react'
const learning = vi.hoisted(() => ({
  activeProject: { id: 'a', title: 'My playground', mode: 'playground' },
  projects: [{ id: 'a', title: 'My playground', mode: 'playground' }],
  createProject: vi.fn(), updateProject: vi.fn(), deleteProject: vi.fn(), exportProject: vi.fn(), openImportedProject: vi.fn(), selectProject: vi.fn(),
}))
vi.mock('@/lib/learning/learning-provider', () => ({ useLearning: () => learning }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('next/dynamic', () => ({ default: () => () => null }))
vi.mock('@/components/platform/project-archive-export', () => ({ ProjectArchiveExport: () => null }))
vi.mock('@/components/platform/project-source-import', () => ({ ProjectSourceImport: () => null }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
beforeEach(() => {
  learning.activeProject = { id: 'a', title: 'My playground', mode: 'playground' }
  learning.createProject.mockResolvedValue({ id: 'b', title: 'New project' }); learning.updateProject.mockResolvedValue(undefined)
})
afterEach(() => { cleanup(); vi.resetAllMocks() })
it.each(['New', 'Rename'])('labels the %s project input and permits keyboard form submission', async action => {
  render(<ProjectSwitcher />)
  fireEvent.click(screen.getByRole('button', { name: 'My playground' }))
  const current = screen.getByRole('button', { name: 'My playground (playground)' })
  expect(current.getAttribute('aria-current')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: action }))
  const name = await screen.findByRole('textbox', { name: 'Project name' })
  await waitFor(() => expect(document.activeElement).toBe(name))
  fireEvent.change(name, { target: { value: 'New project' } })
  fireEvent.submit(name.closest('form')!)
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'My playground' }))
  if (action === 'New') expect(learning.createProject).toHaveBeenCalledWith({ title: 'New project' })
  else expect(learning.updateProject).toHaveBeenCalledWith('a', { title: 'New project' })
})

it('restores focus to the new project trigger after the scoped workspace remounts', async () => {
  function ProjectScope() {
    const [id, setId] = useState('a')
    learning.createProject.mockImplementation(async () => {
      learning.activeProject = { id: 'b', title: 'New project', mode: 'playground' }
      setId('b')
      return learning.activeProject
    })
    return <ProjectSwitcher key={id} />
  }
  render(<ProjectScope />)
  fireEvent.click(screen.getByRole('button', { name: 'My playground' }))
  fireEvent.click(screen.getByRole('button', { name: 'New' }))
  const name = await screen.findByRole('textbox', { name: 'Project name' })
  fireEvent.change(name, { target: { value: 'New project' } })
  fireEvent.submit(name.closest('form')!)
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New project' })))
})

it('restores focus after the old workspace unmounts while chat history loads', async () => {
  let finishLoading: () => void = () => {}
  function ProjectScope() {
    const [loaded, setLoaded] = useState(true)
    finishLoading = () => setLoaded(true)
    learning.createProject.mockImplementation(async () => {
      learning.activeProject = { id: 'b', title: 'New project', mode: 'playground' }
      setLoaded(false)
      return learning.activeProject
    })
    return loaded ? <ProjectSwitcher /> : <main role="status">Opening project conversation…</main>
  }
  render(<ProjectScope />)
  fireEvent.click(screen.getByRole('button', { name: 'My playground' }))
  fireEvent.click(screen.getByRole('button', { name: 'New' }))
  const name = await screen.findByRole('textbox', { name: 'Project name' })
  fireEvent.submit(name.closest('form')!)
  await screen.findByRole('status')
  // The next-tick fallback has already run; the matching trigger does not exist yet.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  act(() => finishLoading())
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New project' })))
})
