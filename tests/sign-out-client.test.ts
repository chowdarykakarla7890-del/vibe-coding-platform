import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setCloudAccount } from '@/lib/learning/cloud-request'
import { SIGN_OUT_TIMEOUT_MS, SIGN_OUT_UNCONFIRMED, signOutWorkspace } from '@/lib/auth/sign-out'

const userId = '11111111-1111-4111-8111-111111111111'
beforeEach(() => setCloudAccount(userId))
afterEach(() => { setCloudAccount(undefined); vi.unstubAllGlobals(); vi.useRealTimers() })

it('sends one same-origin account-bound request and accepts only a confirmed receipt', async () => {
  const fetcher = vi.fn(async () => Response.json({ signedOut: true }))
  vi.stubGlobal('fetch', fetcher)
  await signOutWorkspace(userId, new AbortController().signal)
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('/auth/sign-out', expect.objectContaining({
    method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
  }))
  const headers = new Headers((fetcher.mock.calls as unknown as [string, RequestInit][])[0][1].headers)
  expect(headers.get('X-CodeTutor-Account')).toBe(userId)
  expect(headers.get('accept')).toBe('application/json')
})

it.each([
  () => Response.json({ signedOut: false }),
  () => Response.json({ signedOut: true, redirect: 'https://evil.invalid' }),
  () => new Response('<html>private service details</html>'),
  () => Response.json({ error: { message: 'private provider details' } }, { status: 503 }),
  () => new Response('', { status: 303, headers: { location: 'https://evil.invalid' } }),
])('does not accept or expose invalid/failing response details', async response => {
  const fetcher = vi.fn(async () => response())
  vi.stubGlobal('fetch', fetcher)
  await expect(signOutWorkspace(userId, new AbortController().signal)).rejects.toThrow(SIGN_OUT_UNCONFIRMED)
  expect(fetcher).toHaveBeenCalledOnce()
})

it('requires a reload after a server account mismatch instead of automatic retry', async () => {
  const fetcher = vi.fn(async () => new Response('', { status: 409 }))
  vi.stubGlobal('fetch', fetcher)
  await expect(signOutWorkspace(userId, new AbortController().signal)).rejects.toMatchObject({ name: 'SignOutAccountChangedError' })
  expect(fetcher).toHaveBeenCalledOnce()
})

it.each(['account', 'cancel'])('does not dispatch a stale request after %s changes', async change => {
  const fetcher = vi.fn(), controller = new AbortController()
  vi.stubGlobal('fetch', fetcher)
  if (change === 'account') setCloudAccount('22222222-2222-4222-8222-222222222222')
  else controller.abort()
  await expect(signOutWorkspace(userId, controller.signal)).rejects.toThrow()
  expect(fetcher).not.toHaveBeenCalled()
})

it.each(['headers', 'body'])('settles stalled %s and ignores a late receipt', async phase => {
  vi.useFakeTimers()
  let finish!: (value: unknown) => void
  const stalled = new Promise(resolve => { finish = resolve })
  let signal!: AbortSignal
  const fetcher = vi.fn((_input: unknown, init?: RequestInit) => {
    signal = init?.signal as AbortSignal
    return phase === 'headers' ? stalled : Promise.resolve({ ok: true, status: 200, json: () => stalled })
  })
  vi.stubGlobal('fetch', fetcher)
  const success = vi.fn(), failure = vi.fn()
  const result = signOutWorkspace(userId, new AbortController().signal).then(success, failure)
  await vi.advanceTimersByTimeAsync(SIGN_OUT_TIMEOUT_MS + 1)
  expect(failure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'MutationReceiptTimeoutError' }))
  expect(signal.aborted).toBe(true)
  finish(phase === 'headers' ? Response.json({ signedOut: true }) : { signedOut: true })
  await result
  await vi.advanceTimersByTimeAsync(0)
  expect(success).not.toHaveBeenCalled()
  expect(fetcher).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('does not confirm a previous account after a delayed body', async () => {
  let finish!: (value: unknown) => void
  const body = new Promise(resolve => { finish = resolve })
  const reader = vi.fn(() => body)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: reader })))
  const rejected = expect(signOutWorkspace(userId, new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(reader).toHaveBeenCalledOnce())
  setCloudAccount('22222222-2222-4222-8222-222222222222')
  await rejected
  finish({ signedOut: true })
  await body
})
