import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthApiError, AuthInvalidJwtError, AuthRetryableFetchError, AuthSessionMissingError } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { NextRequest } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { apiFailure, requireUser } from '@/lib/server/api'
import { updateSession } from '@/lib/supabase/proxy'
import { GET as callback } from '@/app/auth/callback/route'
import { POST as signOut } from '@/app/auth/sign-out/route'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({ createServerSupabaseClient: vi.fn() }))
vi.mock('@supabase/ssr', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/supabase/config', () => ({ getPublicSupabaseConfig: () => ({ supabaseUrl: 'https://auth.example', publishableKey: 'test-public-key' }) }))

const getUser = vi.fn(), getClaims = vi.fn()
const request = (path = '/playground', init?: ConstructorParameters<typeof NextRequest>[1]) => new NextRequest(`https://studio.example${path}`, init)

beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  getUser.mockResolvedValue({ data: { user: null }, error: null })
  getClaims.mockResolvedValue({ data: null, error: null })
  vi.mocked(createServerSupabaseClient).mockResolvedValue({ auth: { getUser } } as never)
  vi.mocked(createServerClient).mockReturnValue({ auth: { getUser, getClaims } } as never)
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('authentication service outages', () => {
  it.each(['bad_jwt', 'user_not_found', 'session_expired', 'refresh_token_not_found', 'refresh_token_already_used', 'user_banned'])('requires sign-in for the explicit session failure %s', async code => {
    const error = new AuthApiError('Private authentication detail', 400, code)
    getUser.mockRejectedValue(error)
    getClaims.mockResolvedValue({ data: null, error })
    await expect(requireUser(request())).rejects.toMatchObject({ status: 401 })
    expect((await updateSession(request())).headers.get('location')).toContain('/sign-in')
  })

  it('rejects expired or malformed verified JWTs without mistaking them for an outage', async () => {
    getClaims.mockResolvedValue({ data: null, error: new AuthInvalidJwtError('JWT has expired') })
    expect((await updateSession(request())).status).toBe(307)
  })

  it.each([{}, { data: {} }, { data: { user: { id: '' } } }])('fails closed on malformed user responses', async result => {
    getUser.mockResolvedValue(result)
    await expect(requireUser(request())).rejects.toMatchObject({ status: 503 })
  })

  it.each(['/playground', '/sign-in'])('does not treat an anonymous account as signed in at %s', async path => {
    getUser.mockResolvedValue({ data: { user: { id: 'anonymous', is_anonymous: true } }, error: null })
    getClaims.mockResolvedValue({ data: { claims: { sub: 'anonymous', is_anonymous: true } }, error: null })
    const response = await updateSession(request(path))
    expect(response.status).toBe(path === '/sign-in' ? 200 : 307)
    await expect(requireUser(request())).rejects.toMatchObject({ status: 401 })
  })

  it('does not execute account work when the caller has already aborted', async () => {
    const controller = new AbortController(); controller.abort()
    await expect(requireUser(request('/api/projects', { signal: controller.signal }))).rejects.toMatchObject({ status: 408, code: 'AUTH_INTERRUPTED' })
    expect(createServerSupabaseClient).not.toHaveBeenCalled()
  })

  it('settles a cancelled in-flight user check without accepting its late receipt', async () => {
    const controller = new AbortController()
    let finish!: (result: unknown) => void
    getUser.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const outcome = requireUser(request('/api/projects', { signal: controller.signal }))
    const rejected = expect(outcome).rejects.toMatchObject({ status: 408 })
    await vi.waitFor(() => expect(getUser).toHaveBeenCalledOnce())
    controller.abort()
    await rejected
    finish({ data: { user: { id: 'late-user' } }, error: null })
    await expect(outcome).rejects.toMatchObject({ status: 408 })
  })

  it('bounds a stalled client factory without starting an auth call after the deadline', async () => {
    vi.useFakeTimers()
    let finish!: (client: Awaited<ReturnType<typeof createServerSupabaseClient>>) => void
    vi.mocked(createServerSupabaseClient).mockReturnValue(new Promise(resolve => { finish = resolve }))
    const rejected = expect(requireUser(request())).rejects.toMatchObject({ status: 503 })
    await vi.advanceTimersByTimeAsync(10_001)
    await rejected
    finish({ auth: { getUser } } as never)
    await vi.advanceTimersByTimeAsync(0)
    expect(getUser).not.toHaveBeenCalled()
  })

  it.each(['/playground', '/sign-in'])('bounds a stalled proxy check at %s and rejects late cookie writes', async path => {
    vi.useFakeTimers()
    let finish!: (result: never) => void
    const stalled = new Promise<never>(resolve => { finish = resolve })
    getUser.mockReturnValue(stalled); getClaims.mockReturnValue(stalled)
    const req = request(path)
    const pending = updateSession(req)
    await vi.advanceTimersByTimeAsync(10_001)
    const response = await pending
    expect(response.status).toBe(503)
    const options = vi.mocked(createServerClient).mock.calls[0][2]
    await options.cookies.setAll!([{ name: 'late-auth-cookie', value: 'private-session', options: {} }], {})
    finish({ data: { user: { id: 'late' }, claims: { sub: 'late' } }, error: null } as never)
    await vi.advanceTimersByTimeAsync(0)
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(req.cookies.has('late-auth-cookie')).toBe(false)
  })

  it('preserves acknowledged refresh cookies on an authenticated redirect and denies further writes', async () => {
    getUser.mockImplementation(async () => {
      const options = vi.mocked(createServerClient).mock.calls[0][2]
      await options.cookies.setAll!([{ name: 'first', value: 'one', options: { httpOnly: true } }], {})
      await options.cookies.setAll!([{ name: 'second', value: 'two', options: { httpOnly: true } }], {})
      return { data: { user: { id: 'user-a' } }, error: null }
    })
    const response = await updateSession(request('/sign-in?next=%2Fdsa'))
    expect(response.headers.get('location')).toBe('https://studio.example/dsa')
    expect(response.cookies.get('first')?.value).toBe('one')
    expect(response.cookies.get('second')?.value).toBe('two')
    await vi.mocked(createServerClient).mock.calls[0][2].cookies.setAll!([{ name: 'late', value: 'three', options: {} }], {})
    expect(response.cookies.has('late')).toBe(false)
  })

  it('does not redirect or replay a POST during an auth outage', async () => {
    getClaims.mockRejectedValue(new Error('Unreachable'))
    const response = await updateSession(request('/playground', { method: 'POST' }))
    expect(response.status).toBe(503)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toMatchObject({ error: { code: 'AUTH_UNAVAILABLE', requestId: expect.any(String) } })
    expect(response.headers.get('location')).toBeNull()
  })

  it.each(['/auth/callback', '/auth/sign-out'])('does not bypass authority validation for %s', async path => {
    const response = await updateSession(new NextRequest(`http://127.0.0.1:3112${path}`, { headers: { host: 'evil.invalid' } }))
    expect(response.status).toBe(400)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it.each(['callback', 'sign-out'])('bounds a stalled %s operation without an automatic retry', async kind => {
    vi.useFakeTimers()
    const operation = vi.fn(() => new Promise<never>(() => {}))
    vi.mocked(createServerSupabaseClient).mockResolvedValue({ auth: { exchangeCodeForSession: operation, signOut: operation } } as never)
    const pending = kind === 'callback'
      ? callback(request('/auth/callback?code=private-code&next=%2Fdsa'))
      : signOut(request('/auth/sign-out', { method: 'POST', headers: { origin: 'https://studio.example' } }))
    await vi.advanceTimersByTimeAsync(10_001)
    const response = await pending
    expect(response.status).toBe(kind === 'callback' ? 307 : 503)
    expect(operation).toHaveBeenCalledOnce()
    if (kind === 'callback') {
      const url = new URL(response.headers.get('location')!)
      expect(url.pathname).toBe('/sign-in')
      expect(url.searchParams.get('error')).toBe('callback')
      expect(url.searchParams.get('next')).toBe('/dsa')
    }
    expect(response.headers.get('location') ?? '').not.toContain('private-code')
    expect((vi.mocked(createServerSupabaseClient).mock.calls[0][0] as AbortSignal).aborted).toBe(true)
  })

  it.each([
    new AuthRetryableFetchError('private provider details', 503),
    new AuthApiError('private quota details', 429, 'over_request_rate_limit'),
    new Error('private transport details'),
  ])('does not turn unavailable user checks into signed-out responses: %s', async error => {
    getUser.mockResolvedValue({ data: { user: null }, error })
    await expect(requireUser(request())).rejects.toMatchObject({ status: 503, code: 'AUTH_UNAVAILABLE' })
    const response = await requireUser(request()).catch(error => apiFailure(error, 'auth-request'))
    expect(response).toBeInstanceOf(Response)
    if (!(response instanceof Response)) throw new Error('Expected a safe API response')
    expect(response.headers.get('retry-after')).toBe('5')
    expect(response.headers.get('cache-control')).toContain('no-store')
    const body = await response.text()
    expect(body).not.toContain('private')
    expect(body).toContain('auth-request')
  })

  it.each(['/playground', '/sign-in?next=%2Fdsa'])('fails closed without redirecting during an outage at %s', async path => {
    const error = new AuthRetryableFetchError('private failure', 503)
    getUser.mockRejectedValue(error)
    getClaims.mockRejectedValue(error)
    const response = await updateSession(request(path))
    expect(response.status).toBe(503)
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('x-middleware-next')).toBeNull()
    expect(response.headers.get('retry-after')).toBe('5')
    expect(await response.text()).toContain('Try again')
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private')
  })

  it('does not redirect sign-in using cached claims when live user verification is denied', async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: 'stale-user' } }, error: null })
    getUser.mockResolvedValue({ data: { user: null }, error: new AuthApiError('Deleted user', 403, 'user_not_found') })
    const response = await updateSession(request('/sign-in?next=%2Fplayground'))
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('x-middleware-next')).toBe('1')
    expect(getUser).toHaveBeenCalledOnce()
    expect(getClaims).not.toHaveBeenCalled()
  })

  it.each(['/auth/callback?code=fixture-code', '/auth/sign-out'])('lets %s own its session work instead of waiting for an old token', async path => {
    getClaims.mockRejectedValue(new Error('Old session is unavailable'))
    const response = await updateSession(request(path, path.includes('sign-out') ? { method: 'POST' } : undefined))
    expect(response.headers.get('x-middleware-next')).toBe('1')
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('still rejects a missing session instead of exposing account data', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: new AuthSessionMissingError() })
    await expect(requireUser(request())).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' })
  })

  it('settles an unresponsive auth check after its deadline and ignores its late success', async () => {
    vi.useFakeTimers()
    let finish!: (result: unknown) => void
    getUser.mockReturnValue(new Promise(resolve => { finish = resolve }))
    const succeeded = vi.fn(), failed = vi.fn()
    const pending = requireUser(request()).then(succeeded, failed)
    await vi.advanceTimersByTimeAsync(10_001)
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ status: 503, code: 'AUTH_UNAVAILABLE' }))
    finish({ data: { user: { id: 'late-user' } }, error: null })
    await pending
    expect(succeeded).not.toHaveBeenCalled()
  })
})
