// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConflictReview, ProjectRecovery } from '@/components/workspace/source-recovery'
import { setCloudAccount } from '@/lib/learning/cloud-request'
import { Blob as NodeBlob } from 'node:buffer'
import { useSandboxStore } from '@/app/state'

const account = '11111111-1111-4111-8111-111111111111'
const id = '22222222-2222-4222-8222-222222222222'
const endpoint = `/api/projects/${account}/source-recovery/${id}`
const detail = { conflict: { id, path: 'main.ts', captured: 'terminal copy', reason: 'revision_conflict', createdAt: '2026-08-27T00:00:00Z', resolvedAt: null },
  current: { content: 'saved copy', revision: 3 }, resolution: null }
const receipt = { id, path: 'main.ts', choice: 'merged', revision: 4, deleted: false }
const page = { conflicts: [detail.conflict], pending: 0, incomplete: 0, expired: 0, unresolved: 1, savedOnly: 0, nextCursor: null }
const fetcher = vi.fn(), resolved = vi.fn(), dirty = vi.fn()
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const mount = () => render(<ConflictReview endpoint={endpoint} onResolved={resolved} onDirty={dirty} />)
beforeEach(() => {
  setCloudAccount(account); vi.stubGlobal('fetch', fetcher)
  fetcher.mockImplementation(async () => response(detail))
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})
afterEach(() => { cleanup(); useSandboxStore.getState().clearSandbox(); setCloudAccount(undefined); vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('source conflict review', () => {
  it('applies only on explicit confirmation and notifies the originating editor', async () => {
    useSandboxStore.getState().setSandboxId('sbx_a')
    fetcher.mockResolvedValueOnce(response({ ...detail, resolution: receipt })).mockResolvedValueOnce(response({ ...receipt, sandboxId: 'sbx_a' }))
    mount()
    const button = await screen.findByRole('button', { name: 'Apply to sandbox' })
    expect(fetcher).toHaveBeenCalledOnce()
    fireEvent.click(button); fireEvent.click(button)
    await screen.findByRole('button', { name: 'Recheck application' })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[1][0]).toBe(`${endpoint}/apply`)
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ sandboxId: 'sbx_a', revision: 4 })
    expect(useSandboxStore.getState().sourceUpdate).toMatchObject({ path: 'main.ts', revision: 4, deleted: false })
  })
  it('blocks application over an unsaved editor draft', async () => {
    useSandboxStore.getState().setSandboxId('sbx_a'); useSandboxStore.getState().setDirtyFilePath('main.ts')
    fetcher.mockResolvedValue(response({ ...detail, resolution: receipt }))
    mount(); fireEvent.click(await screen.findByRole('button', { name: 'Apply to sandbox' }))
    expect((await screen.findByRole('alert')).textContent).toContain('unsaved editor draft')
    expect(fetcher).toHaveBeenCalledOnce()
    expect(useSandboxStore.getState().dirtyFilePath).toBe('main.ts')
  })
  it('does not apply a cancelled decision or apply to an expired sandbox', async () => {
    useSandboxStore.getState().setSandboxId('sbx_a')
    fetcher.mockResolvedValue(response({ ...detail, resolution: receipt }))
    vi.mocked(window.confirm).mockReturnValue(false)
    mount(); fireEvent.click(await screen.findByRole('button', { name: 'Apply to sandbox' }))
    expect(fetcher).toHaveBeenCalledOnce()
    act(() => useSandboxStore.getState().setSandboxStatus('sbx_a', 'stopped'))
    expect((screen.getByRole('button', { name: 'Apply to sandbox' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('ignores a late application after project switch', async () => {
    useSandboxStore.getState().setSandboxId('sbx_a')
    let complete!: (value: Response) => void
    fetcher.mockResolvedValueOnce(response({ ...detail, resolution: receipt })).mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    const view = mount(); fireEvent.click(await screen.findByRole('button', { name: 'Apply to sandbox' }))
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    view.unmount(); useSandboxStore.getState().setSandboxId('sbx_b')
    await act(async () => complete(response({ ...receipt, sandboxId: 'sbx_a' })))
    expect(useSandboxStore.getState().sourceUpdate).toBeUndefined()
    expect(resolved).not.toHaveBeenCalled()
  })
  it.each([409, 410, 502])('retains the saved resolution and offers explicit application retry after %i', async status => {
    useSandboxStore.getState().setSandboxId('sbx_a')
    fetcher.mockResolvedValueOnce(response({ ...detail, resolution: receipt })).mockResolvedValueOnce(response({ error: { message: 'Application not confirmed.' } }, status))
    mount(); fireEvent.click(await screen.findByRole('button', { name: 'Apply to sandbox' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Application not confirmed.')
    expect((screen.getByRole('button', { name: 'Apply to sandbox' }) as HTMLButtonElement).disabled).toBe(false)
    expect(useSandboxStore.getState().sourceUpdate).toBeUndefined()
  })
  it('downloads both reviewed copies without project credentials or account metadata', async () => {
    let exported: Blob | undefined
    vi.stubGlobal('Blob', NodeBlob)
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL(blob: Blob) { exported = blob; return 'blob:test-review' }
      static revokeObjectURL() {}
    })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    mount(); fireEvent.click(await screen.findByRole('button', { name: 'Download both copies' }))
    const value = JSON.parse(await exported!.text())
    expect(value).toEqual({ version: 1, kind: 'codetutor-source-review', path: 'main.ts', captured: 'terminal copy', saved: { content: 'saved copy', revision: 3 }, resolution: null })
  })
  it('shows saved/terminal copies as text, with keyboard-accessible comparison regions', async () => {
    mount()
    expect((await screen.findByLabelText('Latest saved version')).textContent).toBe('saved copy')
    expect(screen.getByLabelText('Captured terminal version').getAttribute('tabindex')).toBe('0')
    expect(screen.getByRole('button', { name: 'Download both copies' })).toBeTruthy()
    expect(new Headers(fetcher.mock.calls[0][1].headers).get('X-CodeTutor-Account')).toBe(account)
  })
  it('preserves a merge draft across stale-revision failure and explicit reload', async () => {
    fetcher.mockResolvedValueOnce(response(detail)).mockResolvedValueOnce(response({ error: { message: 'Source changed. Reload comparison.' } }, 409))
      .mockResolvedValueOnce(response({ ...detail, current: { content: 'new saved copy', revision: 4 } })).mockResolvedValueOnce(response({ ...receipt, revision: 5 }))
    mount(); fireEvent.click(await screen.findByRole('button', { name: 'Merge manually' }))
    fireEvent.change(screen.getByLabelText('Merged source'), { target: { value: 'my merge' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save merged version' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Source changed')
    fireEvent.click(screen.getByRole('button', { name: 'Reload comparison' }))
    await waitFor(() => expect(screen.getByLabelText('Latest saved version').textContent).toBe('new saved copy'))
    expect((screen.getByLabelText('Merged source') as HTMLTextAreaElement).value).toBe('my merge')
    fireEvent.click(screen.getByRole('button', { name: 'Save merged version' }))
    await waitFor(() => expect(resolved).toHaveBeenCalledOnce())
    expect(JSON.parse(fetcher.mock.calls[3][1].body)).toEqual({ choice: 'merged', revision: 4, content: 'my merge' })
    expect(screen.getByRole('status').textContent).toContain('Saved revision 5')
    expect((screen.getByRole('button', { name: 'Apply to sandbox' }) as HTMLButtonElement).disabled).toBe(true)
    expect(dirty).toHaveBeenLastCalledWith(false)
  })
  it('requires confirmation and never sends a cancelled resolution', async () => {
    vi.mocked(window.confirm).mockReturnValue(false)
    mount(); fireEvent.click(await screen.findByRole('button', { name: 'Keep saved version' }))
    expect(fetcher).toHaveBeenCalledOnce(); expect(resolved).not.toHaveBeenCalled()
  })
  it('labels terminal deletion distinctly and submits the reviewed tombstone revision', async () => {
    fetcher.mockResolvedValueOnce(response({ ...detail, conflict: { ...detail.conflict, captured: null } })).mockResolvedValueOnce(response({ ...receipt, choice: 'captured', deleted: true }))
    mount(); fireEvent.click(await screen.findByRole('button', { name: 'Accept terminal deletion' }))
    await waitFor(() => expect(resolved).toHaveBeenCalledOnce())
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ choice: 'captured', revision: 3 })
  })
  it('prevents duplicate resolution requests while a save is pending', async () => {
    let complete!: (value: Response) => void
    fetcher.mockResolvedValueOnce(response(detail)).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    mount(); const button = await screen.findByRole('button', { name: 'Keep saved version' })
    fireEvent.click(button); fireEvent.click(button)
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    await act(async () => complete(response({ ...receipt, choice: 'saved' })))
    expect(resolved).toHaveBeenCalledOnce()
  })
  it('aborts an obsolete resolution and ignores its late receipt on unmount', async () => {
    let complete!: (value: Response) => void
    fetcher.mockResolvedValueOnce(response(detail)).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    const view = mount(); fireEvent.click(await screen.findByRole('button', { name: 'Keep saved version' }))
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    const signal = fetcher.mock.calls[1][1].signal
    view.unmount(); expect(signal.aborted).toBe(true)
    await act(async () => complete(response({ ...receipt, choice: 'saved' })))
    expect(resolved).not.toHaveBeenCalled()
  })
  it('does not adopt a resolution completed after an account change', async () => {
    let complete!: (value: Response) => void
    fetcher.mockResolvedValueOnce(response(detail)).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    mount(); fireEvent.click(await screen.findByRole('button', { name: 'Keep saved version' }))
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    setCloudAccount('33333333-3333-4333-8333-333333333333')
    await act(async () => complete(response({ ...receipt, choice: 'saved' })))
    expect(resolved).not.toHaveBeenCalled()
  })
  it('does not send oversized manual merges', async () => {
    mount(); fireEvent.click(await screen.findByRole('button', { name: 'Merge manually' }))
    fireEvent.change(screen.getByLabelText('Merged source'), { target: { value: 'x'.repeat(262145) } })
    fireEvent.click(screen.getByRole('button', { name: 'Save merged version' }))
    expect((await screen.findByRole('alert')).textContent).toContain('256 KB')
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('keeps resolved copies readable without presenting mutation controls', async () => {
    fetcher.mockResolvedValue(response({ ...detail, resolution: receipt }))
    mount(); await screen.findByLabelText('Saved version reviewed')
    expect(screen.queryByRole('button', { name: 'Use terminal version' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Download both copies' })).toBeTruthy()
  })
})

describe('project source recovery status', () => {
  it('offers explicit bounded retry without claiming the files are already saved', async () => {
    let complete!: (value: Response) => void
    fetcher.mockResolvedValueOnce(response({ ...page, unresolved: 0, incomplete: 1, paused: 1 }))
      .mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
      .mockResolvedValue(response({ ...page, unresolved: 0, pending: 1, paused: 0 }))
    render(<ProjectRecovery projectId={account} />)
    await screen.findByText('Background source saving paused — retry needed')
    fireEvent.click(screen.getByRole('button', { name: 'Review source' }))
    const retry = screen.getByRole('button', { name: 'Retry background saves' })
    fireEvent.click(retry); fireEvent.click(retry)
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ action: 'retry' })
    expect(fetcher.mock.calls[1][0]).toBe(`/api/projects/${account}/source-recovery`)
    await act(async () => complete(response({ resumed: 1 })))
    expect(screen.getByText(/1 background save\(s\) queued/)).toBeTruthy()
    await screen.findByText('Saving terminal changes…')
  })
  it('shows an expired-sandbox retry failure without repeating the mutation', async () => {
    fetcher.mockResolvedValueOnce(response({ ...page, paused: 1 }))
      .mockResolvedValueOnce(response({ error: { message: 'The original sandbox has expired.' } }, 410))
    render(<ProjectRecovery projectId={account} />)
    await screen.findByText('1 source conflict need review')
    fireEvent.click(screen.getByRole('button', { name: 'Review source' }))
    fireEvent.click(screen.getByRole('button', { name: 'Retry background saves' }))
    await screen.findByText('The original sandbox has expired.')
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect((screen.getByRole('button', { name: 'Retry background saves' }) as HTMLButtonElement).disabled).toBe(false)
  })
  it('cancels an obsolete retry request on project unmount and ignores its late result', async () => {
    let complete!: (value: Response) => void
    fetcher.mockResolvedValueOnce(response({ ...page, paused: 1 }))
      .mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    const view = render(<ProjectRecovery projectId={account} />)
    await screen.findByText('1 source conflict need review')
    fireEvent.click(screen.getByRole('button', { name: 'Review source' }))
    fireEvent.click(screen.getByRole('button', { name: 'Retry background saves' }))
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    const signal = fetcher.mock.calls[1][1].signal
    view.unmount(); expect(signal.aborted).toBe(true)
    await act(async () => complete(response({ resumed: 1 })))
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('asks before closing a review with an unsaved merge draft', async () => {
    fetcher.mockImplementation(async (path: string) => response(path.endsWith(id) ? detail : page))
    render(<ProjectRecovery projectId={account} />)
    await screen.findByText('1 source conflict need review')
    fireEvent.click(screen.getByRole('button', { name: 'Review source' }))
    fireEvent.click(screen.getByRole('button', { name: /main.ts/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Merge manually' }))
    fireEvent.change(screen.getByLabelText('Merged source'), { target: { value: 'unsaved merge' } })
    vi.mocked(window.confirm).mockReturnValue(false)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('unsaved merge'))
    expect(screen.getByRole('dialog')).toBeTruthy()
    vi.mocked(window.confirm).mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
  it('keeps saved-only resolution guidance visible when the review dialog closes', async () => {
    fetcher.mockResolvedValue(response({ ...page, conflicts: [], unresolved: 0, savedOnly: 1 }))
    render(<ProjectRecovery projectId={account} />)
    await screen.findByText('Saved resolutions available — review sandbox application')
    fireEvent.click(screen.getByRole('button', { name: 'Review source' }))
    expect(screen.getByText(/not a live synchronization check/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.getByRole('status').textContent).toContain('review sandbox application')
  })
  it('opens the review list and exposes incomplete capture honestly', async () => {
    fetcher.mockResolvedValue(response({ ...page, incomplete: 1 }))
    render(<ProjectRecovery projectId={account} />)
    await screen.findByText('1 source conflict need review')
    fireEvent.click(screen.getByRole('button', { name: 'Review source' }))
    expect(screen.getByText(/unsaved terminal changes may be missing/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /main.ts/ })).toBeTruthy()
  })
  it('stops polling after a failure and retries only on request', async () => {
    vi.useFakeTimers()
    fetcher.mockResolvedValueOnce(response({ error: { message: 'Sign in again.' } }, 401)).mockResolvedValue(response(page))
    render(<ProjectRecovery projectId={account} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(screen.getByRole('status').textContent).toContain('unavailable')
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(fetcher).toHaveBeenCalledOnce()
    fireEvent(document, new Event('visibilitychange'))
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(fetcher).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Retry status' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
