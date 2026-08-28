// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SignInForm } from '@/components/auth/sign-in-form'
import { navigateToOAuth } from '@/lib/auth/sign-in-methods'

const auth = vi.hoisted(() => ({ signInWithOAuth: vi.fn(), signInWithOtp: vi.fn() }))
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ auth }) }))
vi.mock('@/lib/supabase/config', () => ({ getPublicSupabaseConfig: () => ({ supabaseUrl: 'https://auth.example', publishableKey: 'sb_publishable_test' }) }))
vi.mock('@/lib/auth/sign-in-methods', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/auth/sign-in-methods')>(), navigateToOAuth: vi.fn() }))

const settings = { external: { email: true, github: true, google: true }, disable_signup: false }
function oauthResult(provider: string, redirectTo: string) {
  const url = new URL('https://auth.example/auth/v1/authorize')
  url.searchParams.set('provider', provider)
  url.searchParams.set('redirect_to', redirectTo)
  return { data: { url: url.toString() }, error: null }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json(settings)))
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetAllMocks() })

async function openForm() {
  const view = render(<SignInForm callbackFailed={false} next="/dsa?difficulty=beginner" />)
  await act(() => vi.advanceTimersByTimeAsync(0))
  return view
}

it('settles an unconfirmed email request without sending again automatically', async () => {
  auth.signInWithOtp.mockImplementation(() => new Promise(() => {}))
  const view = await openForm()
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'learner@example.com' } })
  fireEvent.submit(view.container.querySelector('form')!)
  await act(() => vi.advanceTimersByTimeAsync(20_001))
  expect(screen.queryByRole('alert')?.textContent).toMatch(/could not be confirmed/i)
  expect((screen.getByRole('button', { name: /email/i }) as HTMLButtonElement).disabled).toBe(false)
  expect(auth.signInWithOtp).toHaveBeenCalledOnce()
})

it('offers Google when the configured service enables it', async () => {
  await openForm()
  expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeTruthy()
})

it('starts with a stable loading state and hides disabled providers', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ ...settings, external: { email: true, github: true, google: false } }))
  render(<SignInForm callbackFailed={false} />)
  expect(screen.getByRole('status').textContent).toBe('Loading sign-in options…')
  expect(screen.queryByRole('button', { name: /Continue/ })).toBeNull()
  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(screen.getByRole('button', { name: 'Continue with GitHub' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Continue with Google' })).toBeNull()
})

it('keeps existing-account sign-in available while registrations are disabled', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ ...settings, disable_signup: true }))
  await openForm()
  expect(screen.getByText(/New registrations are closed/)).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Continue with email' }) as HTMLButtonElement).disabled).toBe(false)
})

it.each(['unavailable', 'malformed', 'all-disabled'] as const)('offers one explicit retry when settings are %s', async state => {
  vi.mocked(fetch).mockResolvedValueOnce(state === 'unavailable' ? new Response('private-detail', { status: 503 }) : Response.json(state === 'malformed' ? {} : { ...settings, external: { email: false, github: false, google: false } }))
  await openForm()
  expect(screen.queryByRole('button', { name: /Continue/ })).toBeNull()
  expect(screen.getByRole('alert').textContent).not.toContain('private-detail')
  await act(() => vi.advanceTimersByTimeAsync(30_000))
  expect(fetch).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: 'Retry sign-in options' }))
  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeTruthy()
  expect(fetch).toHaveBeenCalledTimes(2)
})

it.each(['headers', 'body'] as const)('bounds stalled settings %s and ignores late results after retry', async phase => {
  let finish!: (value: unknown) => void
  const stalled = new Promise(resolve => { finish = resolve })
  vi.mocked(fetch).mockImplementationOnce(() => phase === 'headers' ? stalled as Promise<Response> : Promise.resolve({ ok: true, json: () => stalled } as Response))
  await openForm()
  const signal = vi.mocked(fetch).mock.calls[0][1]!.signal!
  await act(() => vi.advanceTimersByTimeAsync(10_001))
  expect(signal.aborted).toBe(true)
  expect(screen.getByRole('alert').textContent).toMatch(/could not be loaded/)
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ ...settings, external: { email: true, github: true, google: false } }))
  fireEvent.click(screen.getByRole('button', { name: 'Retry sign-in options' }))
  await act(() => vi.advanceTimersByTimeAsync(0))
  await act(async () => { finish(phase === 'headers' ? Response.json(settings) : settings) })
  expect(screen.queryByRole('button', { name: 'Continue with Google' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Continue with email' })).toBeTruthy()
})

it('aborts the settings read on unmount without starting authentication', async () => {
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(() => {}))
  const view = await openForm()
  const signal = vi.mocked(fetch).mock.calls[0][1]!.signal!
  view.unmount()
  expect(signal.aborted).toBe(true)
  expect(auth.signInWithOtp).not.toHaveBeenCalled()
  expect(auth.signInWithOAuth).not.toHaveBeenCalled()
})

it.each(['github', 'google'] as const)('opens only the configured %s PKCE flow with the safe activity destination', async provider => {
  auth.signInWithOAuth.mockImplementation(async ({ provider, options }) => oauthResult(provider, options.redirectTo))
  await openForm()
  fireEvent.click(screen.getByRole('button', { name: `Continue with ${provider === 'github' ? 'GitHub' : 'Google'}` }))
  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(auth.signInWithOAuth).toHaveBeenCalledOnce()
  const options = auth.signInWithOAuth.mock.calls[0][0].options
  expect(options.skipBrowserRedirect).toBe(true)
  expect(new URL(options.redirectTo).searchParams.get('next')).toBe('/dsa?difficulty=beginner')
  expect(new URL(options.redirectTo).origin).toBe(window.location.origin)
  expect(navigateToOAuth).toHaveBeenCalledExactlyOnceWith(oauthResult(provider, options.redirectTo).data.url)
})

it.each(['timeout', 'unmount'] as const)('never redirects from a late OAuth response after %s', async ending => {
  let finish!: (value: unknown) => void
  auth.signInWithOAuth.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const view = await openForm()
  fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }))
  await act(() => vi.advanceTimersByTimeAsync(0))
  const callback = auth.signInWithOAuth.mock.calls[0][0].options.redirectTo
  if (ending === 'unmount') view.unmount()
  else {
    await act(() => vi.advanceTimersByTimeAsync(20_001))
    expect(screen.getByRole('alert').textContent).toMatch(/could not be confirmed/)
  }
  await act(async () => finish(oauthResult('google', callback)))
  expect(navigateToOAuth).not.toHaveBeenCalled()
  expect(auth.signInWithOAuth).toHaveBeenCalledOnce()
})

it('does not label email as sending during OAuth or dispatch twice before rerender', async () => {
  auth.signInWithOAuth.mockImplementation(() => new Promise(() => {}))
  await openForm()
  const button = screen.getByRole('button', { name: 'Continue with GitHub' })
  act(() => { fireEvent.click(button); fireEvent.click(button) })
  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(auth.signInWithOAuth).toHaveBeenCalledOnce()
  expect(screen.queryByText('Sending link…')).toBeNull()
  expect((screen.getByRole('button', { name: 'Continue with email' }) as HTMLButtonElement).disabled).toBe(true)
})

it.each(['error', 'missing-url', 'wrong-origin'] as const)('rejects an OAuth %s without exposing details or redirecting', async mode => {
  auth.signInWithOAuth.mockResolvedValue(mode === 'error' ? { error: new Error('secret-provider-detail') } : { data: { url: mode === 'missing-url' ? null : 'https://evil.invalid/' }, error: null })
  await openForm()
  fireEvent.click(screen.getByRole('button', { name: 'Continue with GitHub' }))
  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(screen.getByRole('alert').textContent).toBe('GitHub sign-in could not be started. Please retry.')
  expect(navigateToOAuth).not.toHaveBeenCalled()
})

it('sends one email and requires an explicit resend after the cooldown', async () => {
  auth.signInWithOtp.mockResolvedValue({ error: null })
  const view = await openForm()
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'learner@example.com' } })
  const form = view.container.querySelector('form')!
  act(() => { fireEvent.submit(form); fireEvent.submit(form) })
  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(auth.signInWithOtp).toHaveBeenCalledOnce()
  expect(new URL(auth.signInWithOtp.mock.calls[0][0].options.emailRedirectTo).searchParams.get('next')).toBe('/dsa?difficulty=beginner')
  expect(screen.getByRole('status').textContent).toMatch(/newest link/)
  expect((screen.getByRole('button', { name: /in a minute/ }) as HTMLButtonElement).disabled).toBe(true)
  await act(() => vi.advanceTimersByTimeAsync(60_001))
  expect(auth.signInWithOtp).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: 'Request another link' }))
  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(auth.signInWithOtp).toHaveBeenCalledTimes(2)
})

it.each([429, 500])('handles email status %s without raw errors and keeps the address for retry', async status => {
  auth.signInWithOtp.mockResolvedValue({ error: { status, message: 'secret-provider-detail' } })
  const view = await openForm()
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'learner@example.com' } })
  fireEvent.submit(view.container.querySelector('form')!)
  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(screen.getByRole('alert').textContent).toMatch(status === 429 ? /Wait a minute/ : /could not be sent/)
  expect(screen.getByRole('alert').textContent).not.toContain('secret-provider-detail')
  expect((screen.getByLabelText('Email address') as HTMLInputElement).value).toBe('learner@example.com')
  expect((screen.getByRole('button', { name: 'Continue with email' }) as HTMLButtonElement).disabled).toBe(false)
})

it('does not dispatch an email if unmounted before the operation starts', async () => {
  const view = await openForm()
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'learner@example.com' } })
  fireEvent.submit(view.container.querySelector('form')!)
  view.unmount()
  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(auth.signInWithOtp).not.toHaveBeenCalled()
})

it('allows an explicit fresh OAuth attempt without accepting the earlier timed-out reply', async () => {
  let finish!: (value: unknown) => void
  auth.signInWithOAuth.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockImplementationOnce(async ({ provider, options }) => oauthResult(provider, options.redirectTo))
  await openForm()
  fireEvent.click(screen.getByRole('button', { name: 'Continue with GitHub' }))
  await act(() => vi.advanceTimersByTimeAsync(20_001))
  expect(navigateToOAuth).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }))
  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(navigateToOAuth).toHaveBeenCalledOnce()
  expect(new URL(vi.mocked(navigateToOAuth).mock.calls[0][0]).searchParams.get('provider')).toBe('google')
  await act(async () => finish(oauthResult('github', auth.signInWithOAuth.mock.calls[0][0].options.redirectTo)))
  expect(navigateToOAuth).toHaveBeenCalledOnce()
  expect(screen.queryByRole('alert')).toBeNull()
})

it('does not mark a timed-out email as sent when its acknowledgement arrives late', async () => {
  let finish!: (value: unknown) => void
  auth.signInWithOtp.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const view = await openForm()
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'learner@example.com' } })
  fireEvent.submit(view.container.querySelector('form')!)
  await act(() => vi.advanceTimersByTimeAsync(20_001))
  await act(async () => finish({ error: null }))
  expect(screen.queryByRole('button', { name: 'Link sent' })).toBeNull()
  expect(screen.getByRole('alert').textContent).toMatch(/may still arrive/)
  expect((screen.getByLabelText('Email address') as HTMLInputElement).value).toBe('learner@example.com')
  expect(auth.signInWithOtp).toHaveBeenCalledOnce()
})

it('does not send an empty or malformed email even on an explicit submit event', async () => {
  const view = await openForm()
  fireEvent.submit(view.container.querySelector('form')!)
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'not-an-email' } })
  fireEvent.submit(view.container.querySelector('form')!)
  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(auth.signInWithOtp).not.toHaveBeenCalled()
})
