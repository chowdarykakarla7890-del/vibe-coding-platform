// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { FileExplorer } from '@/components/file-explorer/file-explorer'
import { setCloudAccount } from '@/lib/learning/cloud-request'
import { SandboxReopenRequiredError } from '@/lib/learning/sandbox-recovery'

vi.mock('@/components/file-explorer/file-content', () => ({ FileContent: function TestEditor({ path, readOnly, onDirtyChange }: { path: string; readOnly?: boolean; onDirtyChange?: (dirty: boolean) => void }) {
  const [draft, setDraft] = useState('saved source')
  return <div><div data-testid="opened-file">{path}</div><textarea aria-label="Draft" readOnly={readOnly} value={draft} onChange={(event) => { setDraft(event.target.value); onDirtyChange?.(true) }} /></div>
} }))
afterEach(() => { cleanup(); setCloudAccount(undefined); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('file explorer recovery rendering', () => {
  it('starts a workspace directly, prevents double clicks and never dispatches a tutor prompt', async () => {
    let finish!: () => void
    const start = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const prompt = vi.fn()
    window.addEventListener('code-tutor:prompt', prompt)
    try {
      render(<FileExplorer className="" paths={[]} onStartWorkspace={start} />)
      fireEvent.click(screen.getByRole('button', { name: 'Create file or folder' }))
      fireEvent.click(screen.getByRole('button', { name: 'Create blank workspace' }))
      fireEvent.click(screen.getByRole('button', { name: 'Starting workspace…' }))
      expect(start).toHaveBeenCalledOnce()
      expect(screen.getByRole('status').textContent).toContain('Preparing')
      await act(async () => finish())
      expect(screen.queryByRole('button', { name: 'Starting workspace…' })).toBeNull()
      expect(prompt).not.toHaveBeenCalled()
    } finally { window.removeEventListener('code-tutor:prompt', prompt) }
  })

  it('cancels manual startup on project replacement and ignores its late receipt', async () => {
    let finish!: () => void
    const start = vi.fn<(signal: AbortSignal) => Promise<void>>(() => new Promise<void>(resolve => { finish = resolve }))
    const view = render(<FileExplorer key="project-a" className="" paths={[]} onStartWorkspace={start} />)
    fireEvent.click(screen.getByRole('button', { name: 'Create file or folder' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create blank workspace' }))
    view.rerender(<FileExplorer key="project-b" className="" paths={[]} onStartWorkspace={start} />)
    expect(start.mock.calls[0][0].aborted).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Create file or folder' }))
    await act(async () => finish())
    expect(screen.getByRole('button', { name: 'Create blank workspace' })).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('shows a recoverable startup failure without automatic retry', async () => {
    const start = vi.fn().mockRejectedValueOnce(new Error('Source read unavailable')).mockResolvedValueOnce(undefined)
    render(<FileExplorer className="" paths={[]} onStartWorkspace={start} />)
    fireEvent.click(screen.getByRole('button', { name: 'Create file or folder' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create blank workspace' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Source read unavailable')
    expect(start).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Create blank workspace' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('offers reopen instead of a second creation after an unconfirmed association', async () => {
    const start = vi.fn().mockRejectedValue(new SandboxReopenRequiredError())
    render(<FileExplorer className="" paths={[]} onStartWorkspace={start} />)
    fireEvent.click(screen.getByRole('button', { name: 'Create file or folder' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create blank workspace' }))
    await screen.findByRole('button', { name: 'Reopen project' })
    expect(screen.queryByRole('button', { name: 'Create blank workspace' })).toBeNull()
    expect(start).toHaveBeenCalledOnce()
  })

  it.each(['headers', 'body'] as const)('settles a stalled creation %s and ignores the late receipt', async (phase) => {
    setCloudAccount(crypto.randomUUID())
    let finishResponse!: (response: Response) => void
    let finishBody!: (body: unknown) => void
    const pending = new Promise<Response>(resolve => { finishResponse = resolve })
    const response = Response.json({ path: 'new.ts', type: 'file' })
    vi.spyOn(response, 'json').mockReturnValue(new Promise(resolve => { finishBody = resolve }))
    const fetcher = vi.fn().mockImplementationOnce(() => phase === 'headers' ? pending : Promise.resolve(response))
      .mockResolvedValueOnce(Response.json({ error: { message: 'A saved file already exists at this path.' } }, { status: 409 }))
    vi.stubGlobal('fetch', fetcher)
    const created = vi.fn()
    render(<FileExplorer className="" sandboxId="sandbox-a" paths={['main.ts']} onPathsCreated={created} />)
    fireEvent.click(screen.getByRole('button', { name: 'Create file or folder' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'New file path' }), { target: { value: 'new.ts' } })
    vi.useFakeTimers()
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Create file' }))
      await act(async () => { await vi.advanceTimersByTimeAsync(35_001) })
      expect(screen.queryByRole('button', { name: 'Creating…' })).toBeNull()
      expect(screen.getByRole('alert').textContent).toMatch(/could not be confirmed/i)
      expect((screen.getByRole('textbox', { name: 'New file path' }) as HTMLInputElement).value).toBe('new.ts')
      expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true)
      expect(fetcher).toHaveBeenCalledOnce()
      expect(created).not.toHaveBeenCalled()
      await act(async () => { finishResponse(Response.json({ path: 'new.ts', type: 'file' })); finishBody({ path: 'new.ts', type: 'file' }) })
      expect(created).not.toHaveBeenCalled()
      expect(screen.getByRole('alert')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Create file' }))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(screen.getByRole('alert').textContent).toMatch(/already exists/i)
      expect(created).not.toHaveBeenCalled()
      expect(fetcher).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['replacement', 'expiration', 'unmount', 'account change'] as const)('ignores file creation receipts after %s', async (change) => {
    setCloudAccount(crypto.randomUUID())
    let finish!: (response: Response) => void
    const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() => new Promise<Response>(resolve => { finish = resolve }))
    vi.stubGlobal('fetch', fetcher)
    const onPathsCreated = vi.fn(), onSelectedPathChange = vi.fn()
    const props = { className: '', sandboxId: 'sandbox-a', paths: ['main.ts'], onPathsCreated, onSelectedPathChange }
    const view = render(<FileExplorer {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Create file or folder' }))
    fireEvent.change(screen.getByPlaceholderText('src/components/card.tsx'), { target: { value: 'new.ts' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create file' }))
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    if (change === 'unmount') view.unmount()
    else if (change === 'account change') setCloudAccount(crypto.randomUUID())
    else view.rerender(<FileExplorer {...props} sandboxId={change === 'replacement' ? 'sandbox-b' : 'sandbox-a'} disabled={change === 'expiration'} />)
    await act(async () => finish(Response.json({ path: 'new.ts', type: 'file' })))
    expect(onPathsCreated).not.toHaveBeenCalled()
    expect(onSelectedPathChange).not.toHaveBeenCalled()
    expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(true)
    if (change !== 'unmount') expect(screen.getByTestId('opened-file').textContent).toBe('main.ts')
  })

  it('keeps a draft typed while creating a file if the learner declines to switch editors', async () => {
    setCloudAccount(crypto.randomUUID())
    let finish!: (response: Response) => void
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve }))
    vi.stubGlobal('fetch', fetcher)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const created = vi.fn()
    render(<FileExplorer className="" sandboxId="sandbox-a" paths={['main.ts']} onPathsCreated={created} />)
    fireEvent.click(screen.getByRole('button', { name: 'Create file or folder' }))
    fireEvent.change(screen.getByPlaceholderText('src/components/card.tsx'), { target: { value: 'new.ts' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create file' }))
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    fireEvent.change(screen.getByRole('textbox', { name: 'Draft' }), { target: { value: 'unsaved work during request' } })
    await act(async () => finish(Response.json({ path: 'new.ts', type: 'file' })))
    expect(created).toHaveBeenCalledExactlyOnceWith(['new.ts'])
    expect(confirm).toHaveBeenCalledWith('Discard unsaved changes in main.ts?')
    expect(screen.getByTestId('opened-file').textContent).toBe('main.ts')
    expect((screen.getByRole('textbox', { name: 'Draft' }) as HTMLTextAreaElement).value).toBe('unsaved work during request')
  })

  it('does not unmount an auto-selected dirty draft when recovery removes its file path', () => {
    const view = render(<FileExplorer className="" sandboxId="sandbox-a" paths={['main.ts', 'other.ts']} />)
    const draft = screen.getByRole('textbox')
    fireEvent.change(draft, { target: { value: 'draft during recovery' } })
    view.rerender(<FileExplorer className="" sandboxId="sandbox-a" paths={['other.ts']} />)
    expect(screen.getByRole('textbox')).toBe(draft)
    expect((draft as HTMLTextAreaElement).value).toBe('draft during recovery')
    expect(screen.getByTestId('opened-file').textContent).toBe('main.ts')
  })
  it('does not forget a dirty draft when reselecting the current file after expiration', () => {
    const onDirtyPathChange = vi.fn()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const props = { className: '', sandboxId: 'sandbox-a', paths: ['main.ts', 'other.ts'], onDirtyPathChange }
    const view = render(<FileExplorer {...props} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'keep this draft' } })
    view.rerender(<FileExplorer {...props} disabled />)
    fireEvent.click(screen.getByRole('button', { name: 'File main.ts' }))
    expect(onDirtyPathChange).toHaveBeenLastCalledWith('main.ts')
    fireEvent.click(screen.getByRole('button', { name: 'File other.ts' }))
    expect(confirm).toHaveBeenCalledOnce()
    expect(screen.getByTestId('opened-file').textContent).toBe('main.ts')
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('keep this draft')
  })

  it('keeps the mounted draft visible and read-only when the sandbox expires', () => {
    const view = render(<FileExplorer className="" sandboxId="sandbox-a" paths={['main.ts']} />)
    const editor = screen.getByRole('textbox', { name: 'Draft' }) as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: 'my unsaved draft' } })
    view.rerender(<FileExplorer className="" sandboxId="sandbox-a" paths={['main.ts']} disabled />)
    expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(editor)
    expect(editor.value).toBe('my unsaved draft')
    expect(editor.readOnly).toBe(true)
  })

  it('opens an actual source file when history also contains a stale directory-as-file entry', () => {
    render(<FileExplorer className="" sandboxId="sandbox-a" paths={['src', 'src/app.ts']} />)
    expect(screen.getByTestId('opened-file').textContent).toBe('src/app.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Folder src' }))
    expect(screen.getByRole('button', { name: 'File app.ts' })).toBeTruthy()
  })

  it('keeps reserved JavaScript property names navigable as normal folder names', () => {
    const selected = vi.fn()
    render(<FileExplorer className="" sandboxId="sandbox-a" paths={['__proto__/app.ts', 'constructor/index.ts']} onSelectedPathChange={selected} />)
    fireEvent.click(screen.getByRole('button', { name: 'Folder constructor' }))
    fireEvent.click(screen.getByRole('button', { name: 'File index.ts' }))
    expect(selected).toHaveBeenLastCalledWith('constructor/index.ts')
    expect(screen.getByTestId('opened-file').textContent).toBe('constructor/index.ts')
  })
})
