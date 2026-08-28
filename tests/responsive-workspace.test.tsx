// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CodeTutorWorkspace } from '@/components/workspace/code-tutor-workspace'
vi.mock('@/app/chat', () => ({ Chat: ({ className }: { className: string }) => <section aria-label="Tutor pane" className={className}><input aria-label="Chat draft" defaultValue="question" /></section> }))
vi.mock('@/app/workbench', () => ({ Workbench: ({ className }: { className: string }) => <section aria-label="Workbench pane" className={className}><input aria-label="Code draft" defaultValue="unsaved code" /></section> }))
vi.mock('@/app/header', () => ({ Header: () => <header>CodeTutor</header> }))
vi.mock('@/lib/learning/learning-provider', () => ({ useLearning: () => ({}) }))
vi.mock('@/components/learning/activity-instructions', () => ({ ActivityInstructions: () => null }))
afterEach(cleanup)
it('switches narrow-screen panes without unmounting drafts and retains desktop columns', () => {
  render(<CodeTutorWorkspace />)
  const chat = screen.getByRole('textbox', { name: 'Chat draft' }) as HTMLInputElement
  const code = screen.getByRole('textbox', { name: 'Code draft' }) as HTMLInputElement
  fireEvent.change(chat, { target: { value: 'unfinished question' } })
  fireEvent.change(code, { target: { value: 'unfinished code' } })
  expect(screen.getByRole('region', { name: 'Workbench pane' }).className).toContain('hidden xl:flex')
  fireEvent.click(screen.getByRole('button', { name: 'Workspace' }))
  expect(screen.getByRole('button', { name: 'Workspace' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByRole('region', { name: 'Tutor pane' }).className).toContain('hidden xl:flex')
  expect(screen.getByRole('region', { name: 'Workbench pane' }).className).not.toContain('hidden')
  fireEvent.click(screen.getByRole('button', { name: 'Tutor' }))
  expect(chat.value).toBe('unfinished question')
  expect(code.value).toBe('unfinished code')
  expect(screen.getByRole('textbox', { name: 'Code draft' })).toBe(code)
  expect(code.closest('section')?.parentElement?.className).toContain('xl:grid-cols-')
})
