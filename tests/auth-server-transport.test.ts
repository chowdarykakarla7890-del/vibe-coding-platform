import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { authFetch, withAuthDeadline } from '@/lib/auth/session-check'

vi.mock('server-only', () => ({}))
vi.mock('next/headers', () => ({ cookies: vi.fn() }))
vi.mock('@supabase/ssr', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/supabase/config', () => ({ getPublicSupabaseConfig: () => ({ supabaseUrl: 'https://auth.example', publishableKey: 'test-public-key' }) }))
const cookieStore = { getAll: vi.fn(() => []), set: vi.fn() }
const options = () => vi.mocked(createServerClient).mock.calls[0][2]

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(cookies).mockResolvedValue(cookieStore as never)
  vi.mocked(createServerClient).mockReturnValue({ auth: {} } as never)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('does not initialize a Supabase client for an already cancelled request', async () => {
  const controller = new AbortController(); controller.abort()
  await expect(createServerSupabaseClient(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(cookies).not.toHaveBeenCalled()
  expect(createServerClient).not.toHaveBeenCalled()
})

it('does not initialize after a cancelled cookie read resolves late', async () => {
  let finish!: (store: Awaited<ReturnType<typeof cookies>>) => void
  vi.mocked(cookies).mockReturnValue(new Promise(resolve => { finish = resolve }))
  const controller = new AbortController()
  const result = createServerSupabaseClient(controller.signal)
  controller.abort()
  finish(cookieStore as never)
  await expect(result).rejects.toMatchObject({ name: 'AbortError' })
  expect(createServerClient).not.toHaveBeenCalled()
})

it('writes refreshed cookies normally and suppresses all late writes after cancellation', async () => {
  const controller = new AbortController()
  await createServerSupabaseClient(controller.signal)
  const updates = [{ name: 'session', value: 'fresh', options: { httpOnly: true } }]
  await options().cookies.setAll!(updates, {})
  expect(cookieStore.set).toHaveBeenCalledExactlyOnceWith('session', 'fresh', { httpOnly: true })
  controller.abort()
  await options().cookies.setAll!([{ ...updates[0], value: 'late' }], {})
  expect(cookieStore.set).toHaveBeenCalledOnce()
})

it('still permits read-only Server Component cookie stores', async () => {
  cookieStore.set.mockImplementation(() => { throw new Error('Read-only cookies') })
  await createServerSupabaseClient(new AbortController().signal)
  expect(() => options().cookies.setAll!([{ name: 'session', value: 'fresh', options: {} }], {})).not.toThrow()
})

it.each(['caller', 'init', 'request'] as const)('preserves the %s abort signal when composing SDK fetch', async kind => {
  const caller = new AbortController(), init = new AbortController(), input = new AbortController()
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'))
  const read = authFetch(caller.signal, fetcher)
  await read(new Request('https://auth.example/auth/v1/user', { signal: input.signal }), kind === 'init'
    ? { signal: init.signal, headers: { 'x-test': 'preserved' } }
    : undefined)
  const signal = fetcher.mock.calls[0][1]?.signal
  expect(signal?.aborted).toBe(false)
  ;({ caller, init, request: input }[kind]).abort()
  expect(signal?.aborted).toBe(true)
  if (kind === 'init') expect(fetcher.mock.calls[0][1]?.headers).toEqual({ 'x-test': 'preserved' })
})

it('does not dispatch an SDK retry after its operation has expired', async () => {
  const controller = new AbortController()
  const fetcher = vi.fn<typeof fetch>()
  const read = authFetch(controller.signal, fetcher)
  controller.abort()
  await expect(read('https://auth.example/auth/v1/user')).rejects.toMatchObject({ name: 'AbortError' })
  expect(fetcher).not.toHaveBeenCalled()
})

it.each(['resolve', 'reject'] as const)('settles a stalled body and prevents late %s from writing session cookies', async outcome => {
  vi.useFakeTimers()
  let finish!: () => void, fail!: () => void
  const body = new Promise<void>((resolve, reject) => { finish = resolve; fail = () => reject(new Error('late provider failure')) })
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue({ json: () => body } as Response)
  vi.stubGlobal('fetch', fetcher)
  const success = vi.fn(), failure = vi.fn()
  const pending = withAuthDeadline(async signal => {
    await createServerSupabaseClient(signal)
    const response = await options().global!.fetch!('https://auth.example/auth/v1/user')
    await response.json()
    await options().cookies.setAll!([{ name: 'session', value: 'late', options: {} }], {})
  }).then(success, failure)
  await vi.advanceTimersByTimeAsync(10_001)
  expect(failure).toHaveBeenCalledWith(expect.objectContaining({ name: 'AuthUnavailableError' }))
  expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
  if (outcome === 'resolve') finish()
  else fail()
  await pending
  await vi.advanceTimersByTimeAsync(0)
  expect(cookieStore.set).not.toHaveBeenCalled()
  expect(success).not.toHaveBeenCalled()
})

it('closes the client on immediate failure but keeps a successful client usable for owned data queries', async () => {
  let failedSignal!: AbortSignal
  await expect(withAuthDeadline(async signal => {
    failedSignal = signal
    throw new Error('private provider failure')
  })).rejects.toMatchObject({ name: 'AuthUnavailableError' })
  expect(failedSignal.aborted).toBe(true)
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'))
  vi.stubGlobal('fetch', fetcher)
  await withAuthDeadline(signal => createServerSupabaseClient(signal))
  await options().global!.fetch!('https://auth.example/rest/v1/projects')
  expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(false)
})
