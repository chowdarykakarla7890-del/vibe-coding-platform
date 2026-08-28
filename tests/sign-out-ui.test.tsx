// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SignOut } from '@/components/auth/sign-out'
import { useSandboxStore } from '@/app/state'
import { setCloudAccount } from '@/lib/learning/cloud-request'
import { openSignInAfterSignOut, SIGN_OUT_TIMEOUT_MS } from '@/lib/auth/sign-out'

const account = vi.hoisted(() => ({ userId: '11111111-1111-4111-8111-111111111111' }))
vi.mock('@/components/auth/user-workspace', () => ({ useWorkspaceAccount: () => account }))
vi.mock('@/lib/auth/sign-out', async original => ({
  ...await original<typeof import('@/lib/auth/sign-out')>(), openSignInAfterSignOut: vi.fn(),
}))
beforeEach(() => {
  account.userId = '11111111-1111-4111-8111-111111111111'
  setCloudAccount(account.userId)
  useSandboxStore.getState().clearSandbox()
})
afterEach(() => {
  cleanup(); setCloudAccount(undefined); useSandboxStore.getState().clearSandbox()
  vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers()
})
function open() {
  render(<><input aria-label="Editor draft" defaultValue="keep my code" /><SignOut /></>)
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
}

it.each(['Return to workspace', 'Escape'])('requires confirmation and supports %s without an API call', async action => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  open()
  expect(screen.getByRole('dialog', { name: 'Sign out of CodeTutor?' })).toBeTruthy()
  if (action === 'Escape') fireEvent.keyDown(document.activeElement!, { key: 'Escape', code: 'Escape' })
  else fireEvent.click(screen.getByRole('button', { name: action }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(fetcher).not.toHaveBeenCalled()
  expect(openSignInAfterSignOut).not.toHaveBeenCalled()
  expect((screen.getByRole('textbox', { name: 'Editor draft' }) as HTMLInputElement).value).toBe('keep my code')
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Sign out' })))
})

it('blocks sign-out before any request when the editor has unsaved changes', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  useSandboxStore.getState().setDirtyFilePath('main.ts')
  open()
  expect(screen.getByRole('alert').textContent).toContain('main.ts')
  const confirm = screen.getByRole('button', { name: 'Confirm sign-out' }) as HTMLButtonElement
  expect(confirm.disabled).toBe(true)
  fireEvent.click(confirm)
  expect(fetcher).not.toHaveBeenCalled()
  expect(useSandboxStore.getState().dirtyFilePath).toBe('main.ts')
  act(() => useSandboxStore.getState().setDirtyFilePath(undefined))
  expect(confirm.disabled).toBe(false)
})

it('makes one pending request, keeps the modal open, and navigates only on confirmation', async () => {
  let finish!: (response: Response) => void
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve }))
  vi.stubGlobal('fetch', fetcher)
  open()
  const confirm = screen.getByRole('button', { name: 'Confirm sign-out' })
  fireEvent.click(confirm); fireEvent.click(confirm)
  expect(screen.getByRole('status').textContent).toBe('Confirming sign-out…')
  expect((screen.getByRole('button', { name: 'Return to workspace' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.keyDown(document.activeElement!, { key: 'Escape', code: 'Escape' })
  expect(screen.getByRole('dialog')).toBeTruthy()
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
  expect(openSignInAfterSignOut).not.toHaveBeenCalled()
  await act(async () => finish(Response.json({ signedOut: true })))
  expect(openSignInAfterSignOut).toHaveBeenCalledOnce()
  expect(screen.getByRole('button', { name: 'Continue to sign in' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Retry sign-out' })).toBeNull()
})

it('keeps failures inside the workspace and retries only when asked', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response('private service details', { status: 503 }))
    .mockResolvedValueOnce(Response.json({ signedOut: true }))
  vi.stubGlobal('fetch', fetcher)
  open()
  fireEvent.click(screen.getByRole('button', { name: 'Confirm sign-out' }))
  const retry = await screen.findByRole('button', { name: 'Retry sign-out' })
  expect(screen.getByRole('alert').textContent).toContain('may already have completed')
  expect(screen.queryByText('private service details')).toBeNull()
  expect(fetcher).toHaveBeenCalledOnce()
  expect(openSignInAfterSignOut).not.toHaveBeenCalled()
  fireEvent.click(retry)
  await waitFor(() => expect(openSignInAfterSignOut).toHaveBeenCalledOnce())
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('requires reopening a stale account instead of offering another logout', async () => {
  const fetcher = vi.fn(async () => new Response('', { status: 409 }))
  vi.stubGlobal('fetch', fetcher)
  open()
  fireEvent.click(screen.getByRole('button', { name: 'Confirm sign-out' }))
  expect((await screen.findByRole('alert')).textContent).toContain('account changed')
  expect((screen.getByRole('button', { name: 'Confirm sign-out' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.queryByRole('button', { name: 'Retry sign-out' })).toBeNull()
  expect(openSignInAfterSignOut).not.toHaveBeenCalled()
})

it('settles a stuck request into retry without losing the editor or navigating later', async () => {
  vi.useFakeTimers()
  let finish!: (response: Response) => void
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve }))
  vi.stubGlobal('fetch', fetcher)
  open()
  fireEvent.click(screen.getByRole('button', { name: 'Confirm sign-out' }))
  await act(async () => { await vi.advanceTimersByTimeAsync(SIGN_OUT_TIMEOUT_MS + 1) })
  expect(screen.getByRole('button', { name: 'Retry sign-out' })).toBeTruthy()
  await act(async () => finish(Response.json({ signedOut: true })))
  expect(openSignInAfterSignOut).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Return to workspace' }))
  expect((screen.getByLabelText('Editor draft') as HTMLInputElement).value).toBe('keep my code')
  expect(fetcher).toHaveBeenCalledOnce()
})

it.each(['unmount', 'account'])('aborts pending confirmation on %s and ignores its late success', async change => {
  let finish!: (response: Response) => void, signal!: AbortSignal
  const fetcher = vi.fn((_url: unknown, init?: RequestInit) => {
    signal = init?.signal as AbortSignal
    return new Promise<Response>(resolve => { finish = resolve })
  })
  vi.stubGlobal('fetch', fetcher)
  const view = render(<SignOut />)
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm sign-out' }))
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
  if (change === 'unmount') view.unmount()
  else {
    account.userId = '22222222-2222-4222-8222-222222222222'
    setCloudAccount(account.userId)
    view.rerender(<SignOut />)
  }
  expect(signal.aborted).toBe(true)
  await act(async () => finish(Response.json({ signedOut: true })))
  expect(openSignInAfterSignOut).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
})
