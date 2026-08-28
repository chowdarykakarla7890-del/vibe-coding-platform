import { beforeEach, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET as callback } from '@/app/auth/callback/route'
import { POST as signOut } from '@/app/auth/sign-out/route'
import { updateSession } from '@/lib/supabase/proxy'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createServerClient } from '@supabase/ssr'
import { withBotId } from 'botid/next/config'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({ createServerSupabaseClient: vi.fn() }))
vi.mock('@supabase/ssr', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/supabase/config', () => ({ getPublicSupabaseConfig: () => ({ supabaseUrl: 'https://auth.example', publishableKey: 'test-public-key' }) }))
const exchange = vi.fn(), logout = vi.fn(), claims = vi.fn(), userLookup = vi.fn()
const botIdPrefix = '/149e9513-01fa-4fb0-aad4-566afd725d1b/2d206a39-8ed7-437e-a3be-862e0f06eea3'
beforeEach(() => {
  vi.resetAllMocks()
  exchange.mockResolvedValue({ error: null })
  logout.mockResolvedValue({ error: null })
  claims.mockResolvedValue({ data: null })
  userLookup.mockResolvedValue({ data: { user: null }, error: null })
  vi.mocked(createServerSupabaseClient).mockResolvedValue({ auth: { exchangeCodeForSession: exchange, signOut: logout } } as never)
  vi.mocked(createServerClient).mockReturnValue({ auth: { getClaims: claims, getUser: userLookup } } as never)
})

it.each(['127.0.0.1', '[::1]', 'localhost'])('keeps callback and sign-out on the exact %s browser origin', async host => {
  const origin = `http://${host}:3112`, headers = { host: `${host}:3112`, origin }
  const result = await callback(new NextRequest(`${origin}/auth/callback?code=fixture-code&next=%2Fdsa`, { headers }))
  expect(result.headers.get('location')).toBe(`${origin}/dsa`)
  expect(exchange).toHaveBeenCalledWith('fixture-code')
  const ended = await signOut(new NextRequest(`${origin}/auth/sign-out`, { method: 'POST', headers }))
  expect(ended.status).toBe(303)
  expect(ended.headers.get('location')).toBe(`${origin}/sign-in`)
  expect(ended.headers.get('cache-control')).toBe('private, no-store')
})

it('keeps signed-out and signed-in proxy redirects on the actual local authority', async () => {
  const headers = { host: '127.0.0.1:3112' }
  const signedOut = await updateSession(new NextRequest('http://127.0.0.1:3112/dsa?difficulty=beginner', { headers }))
  expect(signedOut.headers.get('location')).toBe('http://127.0.0.1:3112/sign-in?next=%2Fdsa%3Fdifficulty%3Dbeginner')
  userLookup.mockResolvedValueOnce({ data: { user: { id: 'test-user' } }, error: null })
  const signedIn = await updateSession(new NextRequest('http://127.0.0.1:3112/sign-in', { headers }))
  expect(signedIn.headers.get('location')).toBe('http://127.0.0.1:3112/playground')
})

it.each(['', '/a-4-a/c.js', '/challenge'])('allows only BotID-owned requests before sign-in: %s', async suffix => {
  const response = await updateSession(new NextRequest(`http://127.0.0.1:3112${botIdPrefix}${suffix}`, {
    headers: { host: '127.0.0.1:3112' },
  }))
  expect(response.headers.get('x-middleware-next')).toBe('1')
  expect(response.headers.get('location')).toBeNull()
  expect(createServerClient).not.toHaveBeenCalled()
})

it('keeps the public namespace aligned with the installed BotID rewrite configuration', async () => {
  const config = withBotId({})
  const rewrites = await config.rewrites!()
  expect(rewrites).toEqual(expect.arrayContaining([
    expect.objectContaining({ source: `${botIdPrefix}/a-4-a/c.js` }),
    expect.objectContaining({ source: `${botIdPrefix}/:path*` }),
  ]))
})

it.each([`${botIdPrefix}-lookalike/a-4-a/c.js`, `${botIdPrefix}/../../playground`, '/playground', '/projects'])('still protects routes outside the exact BotID namespace: %s', async path => {
  const response = await updateSession(new NextRequest(`http://127.0.0.1:3112${path}`, {
    headers: { host: '127.0.0.1:3112' },
  }))
  expect(response.status).toBe(307)
  expect(new URL(response.headers.get('location')!).pathname).toBe('/sign-in')
  expect(claims).toHaveBeenCalledOnce()
})

it('rejects invalid request authority even for a BotID asset', async () => {
  const response = await updateSession(new NextRequest(`http://127.0.0.1:3112${botIdPrefix}/a-4-a/c.js`, {
    headers: { host: 'evil.invalid' },
  }))
  expect(response.status).toBe(400)
  expect(createServerClient).not.toHaveBeenCalled()
})

it('rejects an invalid local Host before session exchange, logout or proxy authentication', async () => {
  const headers = { host: 'evil.invalid', origin: 'http://evil.invalid' }
  expect((await callback(new NextRequest('http://127.0.0.1:3112/auth/callback?code=fixture-code', { headers }))).status).toBe(400)
  expect((await updateSession(new NextRequest('http://127.0.0.1:3112/playground', { headers }))).status).toBe(400)
  expect((await signOut(new NextRequest('http://127.0.0.1:3112/auth/sign-out', { method: 'POST', headers }))).status).toBe(403)
  expect(createServerSupabaseClient).not.toHaveBeenCalled()
  expect(createServerClient).not.toHaveBeenCalled()
})

it('does not use forwarded-host input to change a production callback destination', async () => {
  const result = await callback(new NextRequest('https://studio.example/auth/callback?code=fixture-code&next=https://evil.invalid', {
    headers: { host: 'studio.example', 'x-forwarded-host': 'evil.invalid', 'x-forwarded-proto': 'http' },
  }))
  expect(result.headers.get('location')).toBe('https://studio.example/playground')
})

it('keeps a failed exchange private and on the original origin', async () => {
  exchange.mockRejectedValueOnce(new Error('secret-provider-details'))
  const result = await callback(new NextRequest('http://127.0.0.1:3112/auth/callback?code=fixture-code', { headers: { host: '127.0.0.1:3112' } }))
  expect(result.headers.get('location')).toBe('http://127.0.0.1:3112/sign-in?error=callback')
  expect(result.headers.get('cache-control')).toBe('private, no-store')
})

it('preserves a safe activity destination when the callback must be retried', async () => {
  exchange.mockResolvedValueOnce({ error: new Error('private-provider-detail') })
  const result = await callback(new NextRequest('http://127.0.0.1:3112/auth/callback?code=fixture-code&next=%2Fdsa%2Ftwo-sum%3Flanguage%3Dpython', { headers: { host: '127.0.0.1:3112' } }))
  const location = new URL(result.headers.get('location')!)
  expect(location.searchParams.get('next')).toBe('/dsa/two-sum?language=python')
  expect(location.searchParams.get('error')).toBe('callback')
  expect(location.searchParams.has('code')).toBe(false)
})

it('uses a safe requested destination for an already signed-in visitor', async () => {
  userLookup.mockResolvedValueOnce({ data: { user: { id: 'test-user' } }, error: null })
  const result = await updateSession(new NextRequest('http://127.0.0.1:3112/sign-in?next=%2Fplayground%3FmodelId%3Dopenai%2Fgpt-5-nano', { headers: { host: '127.0.0.1:3112' } }))
  expect(new URL(result.headers.get('location')!).searchParams.get('modelId')).toBe('openai/gpt-5-nano')
})

it.each(['https://evil.invalid', '//evil.invalid', '/auth/sign-out', `/playground?value=${'x'.repeat(2048)}`])('does not propagate an unsafe or oversized retry destination', async next => {
  exchange.mockResolvedValueOnce({ error: new Error('callback-failed') })
  const url = new URL('http://127.0.0.1:3112/auth/callback?code=fixture-code')
  url.searchParams.set('next', next)
  const result = await callback(new NextRequest(url, { headers: { host: '127.0.0.1:3112' } }))
  expect(result.headers.get('location')).toBe('http://127.0.0.1:3112/sign-in?error=callback')
  userLookup.mockResolvedValueOnce({ data: { user: { id: 'test-user' } }, error: null })
  url.pathname = '/sign-in'
  const signedIn = await updateSession(new NextRequest(url, { headers: { host: '127.0.0.1:3112' } }))
  expect(signedIn.headers.get('location')).toBe('http://127.0.0.1:3112/playground')
})

it('does not exchange an oversized code but keeps the safe retry path', async () => {
  const url = new URL('http://127.0.0.1:3112/auth/callback?next=%2Fpractice')
  url.searchParams.set('code', 'x'.repeat(2049))
  const result = await callback(new NextRequest(url, { headers: { host: '127.0.0.1:3112' } }))
  expect(exchange).not.toHaveBeenCalled()
  expect(new URL(result.headers.get('location')!).searchParams.get('next')).toBe('/practice')
})
