// @vitest-environment jsdom
import React, { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileContent } from '@/components/file-explorer/file-content'
import { setCloudAccount } from '@/lib/learning/cloud-request'
import { toast } from 'sonner'

// Exercise editor state and request lifetimes without Monaco's browser worker.
vi.mock('next/dynamic', () => ({ default: () => function TestEditor(props: {
  value?: string; original?: string; modified?: string; onChange?: (value: string) => void; options?: { readOnly?: boolean; editContext?: boolean; originalAriaLabel?: string; modifiedAriaLabel?: string }
}) {
  if (props.original !== undefined) return <div data-testid="comparison" data-edit-context={String(props.options?.editContext)}><pre data-testid="original" aria-label={props.options?.originalAriaLabel}>{props.original}</pre><pre data-testid="modified" aria-label={props.options?.modifiedAriaLabel}>{props.modified}</pre></div>
  return <textarea aria-label="Source editor" data-edit-context={String(props.options?.editContext)} readOnly={props.options?.readOnly} value={props.value} onChange={(event) => props.onChange?.(event.target.value)} />
} }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const initial = (text = 'saved', revision: string | number = 1) => new Response(text, { headers: { 'X-Source-Revision': String(revision) } })
const receipt = (path = 'main.ts', revision = 2) => Response.json({ path, revision })
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
const editor = () => screen.getByRole('textbox', { name: 'Source editor' }) as HTMLTextAreaElement
const change = (text: string) => fireEvent.change(editor(), { target: { value: text } })

beforeEach(() => setCloudAccount(crypto.randomUUID()))
afterEach(() => { cleanup(); setCloudAccount(undefined); vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('revision-aware editor', () => {
  it('uses the stable input backend and explicit names for both diff buffers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(initial()))
    render(<FileContent sandboxId="sbx_a" path="main.ts" />)
    await screen.findByRole('textbox')
    expect(editor().dataset.editContext).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Changes' }))
    expect(screen.getByTestId('comparison').dataset.editContext).toBe('false')
    expect(screen.getByTestId('original').getAttribute('aria-label')).toBe('Saved version')
    expect(screen.getByTestId('modified').getAttribute('aria-label')).toBe('Your draft')
  })
  it.each(['headers', 'body'] as const)('settles a stalled save %s without losing the draft or retrying the write', async (phase) => {
    const pending = deferred<Response>()
    const body = deferred<unknown>()
    const response = receipt()
    vi.spyOn(response, 'json').mockReturnValue(body.promise)
    const fetcher = vi.fn().mockResolvedValueOnce(initial())
      .mockImplementationOnce(() => phase === 'headers' ? pending.promise : Promise.resolve(response))
      .mockResolvedValueOnce(initial('first edit', 2))
      .mockResolvedValueOnce(receipt('main.ts', 3))
    vi.stubGlobal('fetch', fetcher)
    const onSaved = vi.fn()
    render(<FileContent sandboxId="sbx_a" path="main.ts" onSaved={onSaved} />)
    await screen.findByRole('textbox')
    change('first edit')
    vi.useFakeTimers()
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      change('newer unsaved edit')
      await act(async () => { await vi.advanceTimersByTimeAsync(35_001) })
      expect(screen.queryByRole('button', { name: 'Saving…' })).toBeNull()
      expect(screen.getByRole('alert').textContent).toMatch(/could not be confirmed/i)
      expect(fetcher.mock.calls[1][1].signal.aborted).toBe(true)
      expect(editor().value).toBe('newer unsaved edit')
      expect(fetcher).toHaveBeenCalledTimes(2)
      expect(onSaved).not.toHaveBeenCalled()
      expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)

      fireEvent.click(screen.getByRole('button', { name: 'Compare latest' }))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(screen.getByTestId('original').textContent).toBe('first edit')
      expect(screen.getByTestId('modified').textContent).toBe('newer unsaved edit')
      await act(async () => { pending.resolve(receipt()); body.resolve({ path: 'main.ts', revision: 2 }) })
      expect(onSaved).not.toHaveBeenCalled()
      expect(screen.getByTestId('modified').textContent).toBe('newer unsaved edit')

      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(onSaved).toHaveBeenCalledExactlyOnceWith('main.ts', 'newer unsaved edit')
      expect(JSON.parse(fetcher.mock.calls[3][1].body)).toMatchObject({ revision: 2, content: 'newer unsaved edit' })
    } finally {
      vi.useRealTimers()
      vi.restoreAllMocks()
    }
  })

  it.each(['headers', 'body'] as const)('settles a stalled file %s read into Retry and ignores its late result', async (phase) => {
    vi.useFakeTimers()
    try {
      const pending = deferred<Response>()
      const text = deferred<string>()
      const response = initial('unused')
      vi.spyOn(response, 'text').mockReturnValue(text.promise)
      const fetcher = vi.fn().mockImplementationOnce(() => phase === 'headers' ? pending.promise : Promise.resolve(response))
        .mockResolvedValueOnce(initial('restored source', 2))
      vi.stubGlobal('fetch', fetcher)
      render(<FileContent sandboxId="sbx_a" path="main.ts" readOnly />)
      await act(async () => { await vi.advanceTimersByTimeAsync(20_001) })
      expect(screen.getByRole('alert').textContent).toMatch(/timed out/i)
      expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true)
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(editor().value).toBe('restored source')
      await act(async () => { pending.resolve(initial('late source')); text.resolve('late source') })
      expect(editor().value).toBe('restored source')
      expect(fetcher).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
      vi.restoreAllMocks()
    }
  })

  it('refreshes a clean editor after a matching reviewed application', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(initial()).mockResolvedValueOnce(initial('reviewed merge', 4))
    vi.stubGlobal('fetch', fetcher)
    const view = render(<FileContent sandboxId="sbx_a" path="main.ts" />)
    await screen.findByRole('textbox')
    view.rerender(<FileContent sandboxId="sbx_a" path="main.ts" sourceUpdate={{ path: 'main.ts', revision: 4, deleted: false, sequence: 1 }} />)
    await waitFor(() => expect(editor().value).toBe('reviewed merge'))
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('preserves typing during application revalidation and compares it with recovered source', async () => {
    const pending = deferred<Response>()
    const fetcher = vi.fn().mockResolvedValueOnce(initial()).mockReturnValueOnce(pending.promise)
    vi.stubGlobal('fetch', fetcher)
    const dirty = vi.fn()
    const view = render(<FileContent sandboxId="sbx_a" path="main.ts" onDirtyChange={dirty} />)
    await screen.findByRole('textbox')
    view.rerender(<FileContent sandboxId="sbx_a" path="main.ts" onDirtyChange={dirty} sourceUpdate={{ path: 'main.ts', revision: 4, deleted: false, sequence: 1 }} />)
    change('typing while applying')
    await act(async () => pending.resolve(initial('reviewed merge', 4)))
    expect(screen.getByTestId('modified').textContent).toBe('typing while applying')
    expect(screen.getByTestId('original').textContent).toBe('reviewed merge')
    expect(dirty).toHaveBeenLastCalledWith(true)
  })

  it('keeps a draft for copying after revalidating a reviewed deletion', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(initial()).mockResolvedValueOnce(Response.json({ error: { code: 'FILE_DELETED' } }, { status: 404, headers: { 'X-Source-Revision': '4' } }))
    vi.stubGlobal('fetch', fetcher)
    const view = render(<FileContent sandboxId="sbx_a" path="main.ts" />)
    await screen.findByRole('textbox'); change('keep my draft')
    view.rerender(<FileContent sandboxId="sbx_a" path="main.ts" sourceUpdate={{ path: 'main.ts', revision: 4, deleted: true, sequence: 1 }} />)
    expect((await screen.findByTestId('modified')).textContent).toBe('keep my draft')
    expect(screen.getByTestId('original').textContent).toBe('')
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('loads recreated source instead of treating an old deletion receipt as current', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(initial('recreated', 5)))
    render(<FileContent sandboxId="sbx_a" path="main.ts" sourceUpdate={{ path: 'main.ts', revision: 4, deleted: true, sequence: 1 }} />)
    await screen.findByRole('textbox')
    expect(editor().value).toBe('recreated')
    expect(editor().readOnly).toBe(false)
  })

  it('does not refresh for an application to another file', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(initial())
    vi.stubGlobal('fetch', fetcher)
    const view = render(<FileContent sandboxId="sbx_a" path="main.ts" />)
    await screen.findByRole('textbox')
    view.rerender(<FileContent sandboxId="sbx_a" path="main.ts" sourceUpdate={{ path: 'other.ts', revision: 4, deleted: false, sequence: 1 }} />)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(editor().value).toBe('saved')
  })

  it('retains a draft and offers retry after application revalidation fails', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(initial()).mockResolvedValueOnce(new Response('', { status: 502 })).mockResolvedValueOnce(initial('recovered', 4))
    vi.stubGlobal('fetch', fetcher)
    const update = { path: 'main.ts', revision: 4, deleted: false, sequence: 1 }
    const view = render(<FileContent sandboxId="sbx_a" path="main.ts" />)
    await screen.findByRole('textbox'); change('draft')
    view.rerender(<FileContent sandboxId="sbx_a" path="main.ts" sourceUpdate={update} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Retry refresh' }))
    expect((await screen.findByTestId('modified')).textContent).toBe('draft')
    expect(screen.getByTestId('original').textContent).toBe('recovered')
  })

  it('preserves the draft and prevents saves after expiration without refetching', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(initial())
    vi.stubGlobal('fetch', fetcher)
    const view = render(<FileContent sandboxId="sbx_a" path="main.ts" />)
    await screen.findByRole('textbox')
    change('keep this draft')
    view.rerender(<FileContent sandboxId="sbx_a" path="main.ts" readOnly />)
    expect(editor().value).toBe('keep this draft')
    expect(editor().readOnly).toBe(true)
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(fetcher).toHaveBeenCalledOnce()
    expect(screen.getByText(/Copy any unsaved changes/)).toBeTruthy()
  })

  it('keeps typing during an in-flight save and uses the acknowledged revision next', async () => {
    const pending = deferred<Response>()
    const fetcher = vi.fn().mockResolvedValueOnce(initial()).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(receipt('main.ts', 3))
    vi.stubGlobal('fetch', fetcher)
    const onSaved = vi.fn()
    const dirty = vi.fn()
    render(<FileContent sandboxId="sbx_a" path="main.ts" onSaved={onSaved} onDirtyChange={dirty} />)
    await screen.findByRole('textbox')
    change('first edit')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    change('newer edit')
    await act(async () => pending.resolve(receipt()))
    expect(editor().value).toBe('newer edit')
    expect(onSaved).toHaveBeenCalledExactlyOnceWith('main.ts', 'first edit')
    expect(dirty).toHaveBeenLastCalledWith(true)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2))
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ path: 'main.ts', content: 'first edit', revision: 1 })
    expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({ path: 'main.ts', content: 'newer edit', revision: 2 })
    expect(dirty).toHaveBeenLastCalledWith(false)
  })

  it('keeps a conflicting draft and requires Compare latest before another save', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(initial())
      .mockResolvedValueOnce(Response.json({ error: { code: 'SOURCE_CONFLICT', message: 'File changed elsewhere.' } }, { status: 409 }))
      .mockResolvedValueOnce(initial('another writer', 4)).mockResolvedValueOnce(receipt('main.ts', 5))
    vi.stubGlobal('fetch', fetcher)
    render(<FileContent sandboxId="sbx_a" path="main.ts" />)
    await screen.findByRole('textbox')
    change('my unsaved draft')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByRole('alert')
    expect(editor().value).toBe('my unsaved draft')
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Compare latest' }))
    expect((await screen.findByTestId('original')).textContent).toBe('another writer')
    expect(screen.getByTestId('modified').textContent).toBe('my unsaved draft')
    expect(fetcher).toHaveBeenCalledTimes(3)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledOnce())
    expect(JSON.parse(fetcher.mock.calls[3][1].body)).toMatchObject({ content: 'my unsaved draft', revision: 4 })
  })

  it('keeps a draft after a failed save without reporting success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(initial()).mockResolvedValueOnce(Response.json({ error: { message: 'Sandbox unavailable. Source is saved.' } }, { status: 502 })))
    const onSaved = vi.fn()
    render(<FileContent sandboxId="sbx_a" path="main.ts" onSaved={onSaved} />)
    await screen.findByRole('textbox')
    change('draft')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledOnce())
    expect(editor().value).toBe('draft')
    expect(onSaved).not.toHaveBeenCalled()
    expect(screen.getByText('Unsaved changes')).toBeTruthy()
  })

  it('ignores a previous file load after switching paths', async () => {
    const pending = deferred<Response>()
    const fetcher = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(initial('second file'))
    vi.stubGlobal('fetch', fetcher)
    const view = render(<FileContent sandboxId="sbx_a" path="main.ts" />)
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    view.rerender(<FileContent sandboxId="sbx_a" path="second.ts" />)
    await screen.findByRole('textbox')
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true)
    await act(async () => pending.resolve(initial('late old file')))
    expect(editor().value).toBe('second file')
  })

  it('does not acknowledge an old save after unmount', async () => {
    const pending = deferred<Response>()
    const fetcher = vi.fn().mockResolvedValueOnce(initial()).mockReturnValueOnce(pending.promise)
    vi.stubGlobal('fetch', fetcher)
    const onSaved = vi.fn()
    const view = render(<FileContent sandboxId="sbx_a" path="main.ts" onSaved={onSaved} />)
    await screen.findByRole('textbox')
    change('draft')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    view.unmount()
    expect(fetcher.mock.calls[1][1].signal.aborted).toBe(true)
    await act(async () => pending.resolve(receipt()))
    expect(onSaved).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('does not accept a save response after the account changes', async () => {
    const pending = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(initial()).mockReturnValueOnce(pending.promise))
    const onSaved = vi.fn()
    render(<FileContent sandboxId="sbx_a" path="main.ts" onSaved={onSaved} />)
    await screen.findByRole('textbox')
    change('draft')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    setCloudAccount(crypto.randomUUID())
    await act(async () => pending.resolve(receipt()))
    expect(onSaved).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    expect(editor().value).toBe('draft')
  })

  it('retries a failed initial read without an application-level error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('', { status: 502 })).mockResolvedValueOnce(initial('recovered')))
    render(<FileContent sandboxId="sbx_a" path="main.ts" />)
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByRole('textbox')
    expect(editor().value).toBe('recovered')
  })

  it('survives Strict Mode cleanup without dispatching the cancelled first read', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(initial('active load'))
    vi.stubGlobal('fetch', fetcher)
    const view = render(<StrictMode><FileContent sandboxId="sbx_a" path="main.ts" /></StrictMode>)
    await screen.findByRole('textbox')
    change('typing')
    expect(editor().value).toBe('typing')
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(false)
    view.unmount()
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true)
  })

  it.each(['-1', '1.5', '2147483648', '9007199254740993', ''])('rejects invalid revision %s without enabling editing', async (revision) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(initial('saved', revision)))
    render(<FileContent sandboxId="sbx_a" path="main.ts" />)
    expect((await screen.findByRole('alert')).textContent).toContain('valid saved revision')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('rejects a successful save receipt for another file', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(initial()).mockResolvedValueOnce(receipt('other.ts')))
    const onSaved = vi.fn()
    render(<FileContent sandboxId="sbx_a" path="main.ts" onSaved={onSaved} />)
    await screen.findByRole('textbox')
    change('draft')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledOnce())
    expect(onSaved).not.toHaveBeenCalled()
    expect(editor().value).toBe('draft')
  })
})
