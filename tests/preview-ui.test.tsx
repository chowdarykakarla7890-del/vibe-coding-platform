// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Preview } from '@/app/preview'
import { Preview as PreviewFrame } from '@/components/preview/preview'
import { useSandboxStore } from '@/app/state'
import { setCloudAccount } from '@/lib/learning/cloud-request'

const learning = vi.hoisted(() => ({ activeProject: { id: '11111111-1111-4111-8111-111111111111', sandboxId: 'owned-a' } }))
vi.mock('@/lib/learning/learning-provider', () => ({ useLearning: () => learning }))
const projectA = '11111111-1111-4111-8111-111111111111', projectB = '22222222-2222-4222-8222-222222222222'
const user = '33333333-3333-4333-8333-333333333333'
const receipt = { projectId: projectA, sandboxId: 'owned-a', url: 'https://sb-a.vercel.run', ports: [3000, 8000], port: 3000 }
function response(value: unknown = receipt, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }) }
const fetcher = vi.fn<typeof fetch>()
beforeEach(() => {
  learning.activeProject = { id: projectA, sandboxId: 'owned-a' }
  useSandboxStore.getState().setSandboxId('owned-a')
  setCloudAccount(user)
  fetcher.mockResolvedValue(response())
  vi.stubGlobal('fetch', fetcher)
})
afterEach(() => { cleanup(); setCloudAccount(undefined); useSandboxStore.getState().clearSandbox(); vi.unstubAllGlobals(); vi.resetAllMocks(); vi.useRealTimers() })

describe('owned workspace preview', () => {
  it('connects without an AI URL and shows a read-only owned address and exposed ports', async () => {
    useSandboxStore.getState().setUrl('https://forged.vercel.run', 'cached')
    render(<Preview />)
    expect(screen.getByRole('status').textContent).toContain('Connecting')
    expect(screen.queryByTitle('Sandbox preview')).toBeNull()
    const frame = await screen.findByTitle('Sandbox preview')
    expect(frame.getAttribute('src')).toBe(receipt.url)
    expect(frame.getAttribute('sandbox')).not.toContain('allow-top-navigation')
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer')
    const address = screen.getByRole('textbox', { name: 'Preview URL' }) as HTMLInputElement
    expect(address.readOnly).toBe(true)
    expect(address.value).toBe(receipt.url)
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['3000', '8000'])
    expect(screen.getByRole('link', { name: 'Open preview in a new tab' }).getAttribute('rel')).toBe('noopener noreferrer')
    expect(fetcher).toHaveBeenCalledOnce()
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('X-CodeTutor-Account')).toBe(user)
    fireEvent.load(frame)
    expect(screen.queryByRole('status')).toBeNull()
  })
  it('persists an explicit exposed-port selection, then refreshes through a safe read', async () => {
    render(<Preview />)
    await screen.findByTitle('Sandbox preview')
    fetcher.mockResolvedValueOnce(response({ ...receipt, port: 8000, url: 'https://sb-a8000.vercel.run' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Preview port' }), { target: { value: '8000' } })
    await waitFor(() => expect(screen.getByTitle('Sandbox preview').getAttribute('src')).toBe('https://sb-a8000.vercel.run'))
    expect(fetcher.mock.calls[1][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ projectId: projectA, port: 8000 }) })
    fetcher.mockResolvedValueOnce(response({ ...receipt, port: 8000, url: 'https://sb-a8000.vercel.run' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect preview' }))
    await screen.findByTitle('Sandbox preview')
    expect(fetcher.mock.calls[2][0]).toContain('port=8000')
    expect(fetcher.mock.calls[2][1]?.method).toBe('GET')
  })
  it('does not publish late results after switching projects', async () => {
    let finish!: (value: Response) => void
    fetcher.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const view = render(<Preview />)
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    const signal = fetcher.mock.calls[0][1]?.signal
    learning.activeProject = { id: projectB, sandboxId: 'owned-b' }
    fetcher.mockResolvedValueOnce(response({ ...receipt, projectId: projectB, sandboxId: 'owned-b', url: 'https://sb-b.vercel.run' }))
    act(() => useSandboxStore.getState().setSandboxId('owned-b'))
    view.rerender(<Preview />)
    await screen.findByTitle('Sandbox preview')
    expect(signal?.aborted).toBe(true)
    await act(async () => finish(response()))
    expect(screen.getByTitle('Sandbox preview').getAttribute('src')).toBe('https://sb-b.vercel.run')
  })
  it.each([{ ...receipt, projectId: projectB }, { ...receipt, sandboxId: 'other' }, { ...receipt, url: 'https://evil.example' }, { ...receipt, ports: [8000] }])('rejects a mismatched or invalid receipt', async value => {
    fetcher.mockResolvedValueOnce(response(value))
    render(<Preview />)
    await screen.findByRole('alert')
    expect(screen.queryByTitle('Sandbox preview')).toBeNull()
    expect(screen.queryByRole('link', { name: 'Open preview in a new tab' })).toBeNull()
  })
  it('shows an explicit retry after a network error, without a retry loop', async () => {
    fetcher.mockRejectedValueOnce(new TypeError('Offline'))
    render(<Preview />)
    expect((await screen.findByRole('alert')).textContent).toBe('Offline')
    expect(fetcher).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Retry preview' }))
    await screen.findByTitle('Sandbox preview')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it.each(['headers', 'body'])('settles stalled %s and ignores the late result', async stage => {
    vi.useFakeTimers()
    let finish!: (value: unknown) => void
    const pending = new Promise(resolve => { finish = resolve })
    if (stage === 'headers') fetcher.mockReturnValueOnce(pending as Promise<Response>)
    else fetcher.mockResolvedValueOnce({ ok: true, json: () => pending } as Response)
    render(<Preview />)
    await act(async () => { await vi.advanceTimersByTimeAsync(20_001) })
    expect(screen.getByRole('alert').textContent).toContain('timed out')
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
    await act(async () => finish(stage === 'headers' ? response() : receipt))
    expect(screen.queryByTitle('Sandbox preview')).toBeNull()
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('unmounts the iframe and removes its external link on expiry', async () => {
    render(<Preview />)
    await screen.findByTitle('Sandbox preview')
    act(() => useSandboxStore.getState().setSandboxStatus('owned-a', 'stopped'))
    expect(screen.queryByTitle('Sandbox preview')).toBeNull()
    expect(screen.queryByRole('link', { name: 'Open preview in a new tab' })).toBeNull()
    expect(screen.getByText(/This sandbox has stopped/)).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
  })
  it('does not request another project during workspace hydration', () => {
    learning.activeProject = { id: projectB, sandboxId: 'owned-b' }
    render(<Preview />)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('does not reset the preview for unrelated terminal log updates', async () => {
    render(<Preview />)
    const frame = await screen.findByTitle('Sandbox preview')
    act(() => useSandboxStore.getState().addPaths(['new.ts']))
    expect(screen.getByTitle('Sandbox preview')).toBe(frame)
    expect(fetcher).toHaveBeenCalledOnce()
  })
})

describe('preview frame loading', () => {
  it('offers retry instead of an indefinite frame loader and respects reduced motion', async () => {
    vi.useFakeTimers()
    render(<PreviewFrame url={receipt.url} />)
    expect(screen.getByRole('status').querySelector('svg')?.getAttribute('class')).toContain('motion-safe:animate-spin')
    await act(async () => { await vi.advanceTimersByTimeAsync(20_001) })
    expect(screen.getByRole('alert').textContent).toContain('did not finish loading')
    expect(screen.queryByRole('status')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry preview' }))
    expect(screen.getByRole('status')).toBeTruthy()
    fireEvent.load(screen.getByTitle('Sandbox preview'))
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
