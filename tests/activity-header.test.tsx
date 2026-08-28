// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ActivityHeader } from '@/components/workspace/code-tutor-workspace'
import { getActivity } from '@/lib/learning/catalog'
import { useLearning } from '@/lib/learning/learning-provider'

vi.mock('@/app/chat', () => ({ Chat: () => null }))
vi.mock('@/app/header', () => ({ Header: () => null }))
vi.mock('@/app/workbench', () => ({ Workbench: () => null }))
vi.mock('@/lib/learning/learning-provider', () => ({ useLearning: vi.fn() }))
afterEach(() => { cleanup(); vi.resetAllMocks() })
const activity = getActivity('dsa-python-two-sum')!
function progress(activityId: string, bestScore: number, attempts = 1) {
  return { activityId, attempts, bestScore, completed: bestScore === 100, concepts: [], updatedAt: 1 }
}
function setProgress(value: ReturnType<typeof progress>[]) {
  vi.mocked(useLearning).mockReturnValue({ progress: value, projects: [], isReady: true,
    createProject: vi.fn(), deleteProject: vi.fn(), exportProject: vi.fn(), importProject: vi.fn(),
    openImportedProject: vi.fn(), selectProject: vi.fn(), updateProject: vi.fn(), refreshProgress: vi.fn(),
  })
}

it('shows saved activity progress instead of a hardcoded unsubmitted label', () => {
  setProgress([progress(activity.id, 100)])
  render(<ActivityHeader activity={activity} />)
  expect(screen.getByRole('status').textContent).toBe('Best: 100%')
})
it('displays the selected template language rather than the catalog default', () => {
  setProgress([])
  render(<ActivityHeader activity={activity} language="Java" />)
  expect(screen.getByText('Java')).toBeTruthy()
  expect(screen.queryByText('Python')).toBeNull()
})
it('updates when authoritative progress refreshes without remounting the workspace', () => {
  setProgress([])
  const view = render(<ActivityHeader activity={activity} />)
  expect(screen.getByRole('status').textContent).toBe('No scored attempts')
  setProgress([progress(activity.id, 85)])
  view.rerender(<ActivityHeader activity={activity} />)
  expect(screen.getByRole('status').textContent).toBe('Best: 85%')
})
it('preserves a legitimate zero score and does not mix different activities', () => {
  setProgress([progress('different-activity', 100), progress(activity.id, 0)])
  const view = render(<ActivityHeader activity={activity} />)
  expect(screen.getByRole('status').textContent).toBe('Best: 0%')
  setProgress([progress('different-activity', 100)])
  view.rerender(<ActivityHeader activity={activity} />)
  expect(screen.getByRole('status').textContent).toBe('No scored attempts')
})
