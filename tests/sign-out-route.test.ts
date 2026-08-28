import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { POST } from '@/app/auth/sign-out/route'
import { createServerSupabaseClient } from '@/lib/supabase/server'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({ createServerSupabaseClient: vi.fn() }))
const userId = '11111111-1111-4111-8111-111111111111'
const otherId = '22222222-2222-4222-8222-222222222222'
const getUser = vi.fn(), signOut = vi.fn()
function request(headers?: Record<string, string>, signal?: AbortSignal) {
  return new Request('https://studio.example/auth/sign-out', { method: 'POST', signal,
    headers: { origin: 'https://studio.example', accept: 'application/json', 'X-CodeTutor-Account': userId, ...headers } })
}
beforeEach(() => {
  vi.resetAllMocks()
  getUser.mockResolvedValue({ data: { user: { id: userId } }, error: null })
  signOut.mockResolvedValue({ error: null })
  vi.mocked(createServerSupabaseClient).mockResolvedValue({ auth: { getUser, signOut } } as never)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it('acknowledges the current account sign-out as private JSON without a redirect', async () => {
  const response = await POST(request())
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ signedOut: true })
  expect(response.headers.get('location')).toBeNull()
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(response.headers.get('x-request-id')).toBeTruthy()
  expect(getUser).toHaveBeenCalledOnce()
  expect(signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'local' })
})

it('does not sign out a different current account for a stale workspace', async () => {
  getUser.mockResolvedValue({ data: { user: { id: otherId } }, error: null })
  const response = await POST(request())
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ error: { code: 'ACCOUNT_CHANGED' } })
  expect(signOut).not.toHaveBeenCalled()
})

it.each(['', 'invalid', 'x'.repeat(129)])('rejects missing/invalid JSON account identity before Auth: %s', async id => {
  const response = await POST(request({ 'X-CodeTutor-Account': id }))
  expect(response.status).toBe(400)
  expect(createServerSupabaseClient).not.toHaveBeenCalled()
})

it('allows explicit retries after the session is already gone', async () => {
  getUser.mockResolvedValue({ data: { user: null }, error: null })
  const response = await POST(request())
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ signedOut: true })
  expect(signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'local' })
})

it('preserves the same-origin native form redirect', async () => {
  const response = await POST(new Request('https://studio.example/auth/sign-out', { method: 'POST', headers: { origin: 'https://studio.example' } }))
  expect(response.status).toBe(303)
  expect(response.headers.get('location')).toBe('https://studio.example/sign-in')
  expect(signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'local' })
})

it('checks identity even for a form request when an account header is provided', async () => {
  getUser.mockResolvedValue({ data: { user: { id: otherId } }, error: null })
  expect((await POST(request({ accept: 'text/html' }))).status).toBe(409)
  expect(signOut).not.toHaveBeenCalled()
})

it('rejects cross-origin logout before calling Auth', async () => {
  expect((await POST(request({ origin: 'https://evil.invalid' }))).status).toBe(403)
  expect(createServerSupabaseClient).not.toHaveBeenCalled()
})

it.each(['lookup', 'logout'])('redacts a %s service failure and preserves retry metadata', async phase => {
  (phase === 'lookup' ? getUser : signOut).mockRejectedValueOnce(new Error('private provider details'))
  const response = await POST(request())
  expect(response.status).toBe(503)
  expect(response.headers.get('retry-after')).toBe('5')
  expect(await response.json()).toMatchObject({ error: { code: 'AUTH_UNAVAILABLE', requestId: response.headers.get('x-request-id') } })
  expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private provider')
  if (phase === 'lookup') expect(signOut).not.toHaveBeenCalled()
})

it.each(['timeout', 'cancel'])('does not dispatch logout after a %s during identity verification', async mode => {
  vi.useFakeTimers()
  const controller = new AbortController()
  let finish!: (result: unknown) => void
  getUser.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const result = POST(request(undefined, controller.signal))
  await vi.advanceTimersByTimeAsync(0)
  if (mode === 'cancel') controller.abort()
  else await vi.advanceTimersByTimeAsync(10_001)
  expect((await result).status).toBe(mode === 'cancel' ? 408 : 503)
  finish({ data: { user: { id: userId } }, error: null })
  await vi.advanceTimersByTimeAsync(0)
  expect(signOut).not.toHaveBeenCalled()
})
