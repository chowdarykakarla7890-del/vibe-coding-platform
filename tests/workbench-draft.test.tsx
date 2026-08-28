// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Workbench } from '@/app/workbench'
import { useSandboxStore } from '@/app/state'

vi.mock('@/app/file-explorer', () => ({ FileExplorer: function DraftEditor() {
  const [draft, setDraft] = useState('saved source')
  return <textarea aria-label="Source draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
} }))
vi.mock('@/app/preview', () => ({ Preview: () => <div>App preview</div> }))
vi.mock('@/app/logs', () => ({ Logs: () => <div>Terminal</div> }))
vi.mock('@/components/workspace/source-recovery', () => ({ SourceRecovery: () => null }))
vi.mock('@/components/workspace/sandbox-stop', () => ({ SandboxStop: () => null }))

beforeEach(() => useSandboxStore.getState().clearSandbox())
afterEach(() => { cleanup(); useSandboxStore.getState().clearSandbox() })

describe('workbench draft recovery', () => {
  it('restores the retained Code/Preview selection when the workspace remounts', () => {
    const view = render(<Workbench />)
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    view.unmount()
    render(<Workbench />)
    expect(screen.getByRole('button', { name: 'Preview' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('App preview')).toBeTruthy()
  })
  it('preserves the mounted editor and unsaved source across preview switches', () => {
    render(<Workbench />)
    const editor = screen.getByRole('textbox', { name: 'Source draft' }) as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: 'unsaved work to recover' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(editor.isConnected).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Code' }))
    expect(screen.getByRole('textbox')).toBe(editor)
    expect(editor.value).toBe('unsaved work to recover')
  })
})
