import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server'
import { createServerClient } from '@supabase/ssr'
import { BOTID_PREFIX, contentSecurityPolicy, createNonce } from '@/lib/content-security-policy'
import { updateSession } from '@/lib/supabase/proxy'
import { config } from '@/proxy'

vi.mock('@supabase/ssr', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/supabase/config', () => ({ getPublicSupabaseConfig: () => ({ supabaseUrl: 'https://auth.example', publishableKey: 'test-public-key' }) }))
const getUser = vi.fn(), getClaims = vi.fn()
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://auth.example')
  getUser.mockResolvedValue({ data: { user: null }, error: null })
  getClaims.mockResolvedValue({ data: null, error: null })
  vi.mocked(createServerClient).mockReturnValue({ auth: { getUser, getClaims } } as never)
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })
const request = (path = '/playground') => new NextRequest(`https://studio.example${path}`, {
  headers: { 'x-nonce': 'attacker', 'Content-Security-Policy': "script-src 'unsafe-inline'", cookie: 'existing=retained' },
})
const directives = (policy: string) => Object.fromEntries(policy.split('; ').map(part => {
  const [name, ...sources] = part.split(' '); return [name, sources]
}))

it('uses fresh 144-bit random nonces with no delimiter characters', () => {
  const values = Array.from({ length: 100 }, createNonce)
  expect(new Set(values).size).toBe(100)
  values.forEach(value => { expect(value).toMatch(/^[A-Za-z0-9+/]{24}$/); expect(Buffer.from(value, 'base64')).toHaveLength(18) })
})

it('restricts production scripts/connections/frames without broad eval or inline JavaScript', () => {
  const nonce = createNonce()
  const policy = directives(contentSecurityPolicy(nonce, { origin: 'https://studio.example', supabaseUrl: 'https://auth.example', development: false }))
  expect(policy['script-src']).toEqual(["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", "'wasm-unsafe-eval'"])
  expect(policy['script-src-attr']).toEqual(["'none'"])
  expect(policy['connect-src']).toEqual(["'self'", 'https://auth.example'])
  expect(policy['worker-src']).toEqual(["'self'", 'blob:'])
  expect(policy['frame-src']).toEqual(['https://*.vercel.run', `https://studio.example${BOTID_PREFIX}/`])
  for (const directive of ['frame-ancestors', 'object-src']) expect(policy[directive]).toEqual(["'none'"])
  expect(policy['form-action']).toEqual(["'self'"])
  expect(policy['style-src']).toEqual(["'self'", "'unsafe-inline'"])
})

it.each([undefined, "https://auth.example/; script-src *", 'https://user:secret@auth.example', 'https://auth.example?secret=1', 'http://remote.example', 'data:text/plain,invalid'])('never broadens the policy from invalid auth config %s', supabaseUrl => {
  expect(directives(contentSecurityPolicy(createNonce(), { origin: 'https://studio.example', supabaseUrl, development: false }))['connect-src']).toEqual(["'self'"])
})

it('allows local auth and development HMR without upgrading local production HTTP', () => {
  for (const development of [false, true]) {
    const policy = directives(contentSecurityPolicy(createNonce(), { origin: 'http://127.0.0.1:3115', supabaseUrl: 'http://127.0.0.1:54321', development }))
    expect(policy['connect-src']).toEqual(["'self'", 'http://127.0.0.1:54321', ...development ? ['ws:', 'wss:'] : []])
    expect(policy['script-src'].includes("'unsafe-eval'")).toBe(development)
    expect(policy['upgrade-insecure-requests']).toBeUndefined()
  }
})

it.each(['/playground', '/sign-in', '/auth/callback', '/auth/sign-out'])('replaces spoofed nonces and prevents shared HTML caching on %s', async path => {
  const req = request(path)
  const response = await updateSession(req)
  const policy = response.headers.get('Content-Security-Policy')!
  expect(policy).toContain(`'nonce-${req.headers.get('x-nonce')}'`)
  expect(policy).not.toContain('attacker')
  expect(req.headers.get('Content-Security-Policy')).toBe(policy)
  for (const header of ['Cache-Control', 'CDN-Cache-Control', 'Vercel-CDN-Cache-Control']) expect(response.headers.get(header)).toBe('private, no-store')
  if (response.headers.get('x-middleware-next')) {
    expect(response.headers.get('x-middleware-request-x-nonce')).toBe(req.headers.get('x-nonce'))
    expect(response.headers.get('x-middleware-request-content-security-policy')).toBe(policy)
  }
})

it('preserves the same SSR nonce and existing/new cookies across repeated auth refresh responses', async () => {
  getClaims.mockImplementation(async () => {
    const options = vi.mocked(createServerClient).mock.calls[0][2]
    for (const name of ['refreshed-one', 'refreshed-two']) options.cookies.setAll!([{ name, value: 'fixture', options: { httpOnly: true } }], {})
    return { data: { claims: { sub: 'account' } }, error: null }
  })
  const req = request()
  const response = await updateSession(req)
  expect(response.headers.get('x-middleware-request-x-nonce')).toBe(req.headers.get('x-nonce'))
  expect(response.headers.get('x-middleware-request-content-security-policy')).toBe(response.headers.get('Content-Security-Policy'))
  expect(response.headers.get('x-middleware-request-cookie')).toContain('existing=retained')
  expect(response.cookies.getAll().map(cookie => cookie.name)).toEqual(['refreshed-one', 'refreshed-two'])
})

it('secures the static auth-outage response without leaking provider details', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  getClaims.mockRejectedValue(new Error('private-detail'))
  const response = await updateSession(request())
  expect(response.status).toBe(503)
  expect(response.headers.get('Content-Security-Policy')).toContain("'strict-dynamic'")
  expect(await response.text()).not.toContain('private-detail')
})

it('does not replace the SDK-owned BotID challenge policy', async () => {
  const response = await updateSession(request(`${BOTID_PREFIX}/a-4-a/c.js`))
  expect(response.headers.get('Content-Security-Policy')).toBeNull()
  expect(createServerClient).not.toHaveBeenCalled()
})

it('does not exempt image-looking pages or API lookalikes from auth/CSP', () => {
  for (const url of ['/playground.png', '/unknown.svg', '/api-lookalike', '/_next/static-lookalike', '/vendor/monaco-private']) {
    expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(true)
  }
  for (const url of ['/api/models', '/_next/static/chunk.js', '/vendor/monaco/0.56.0/vs/loader.js', '/file.svg', '/favicon.ico']) {
    expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(false)
  }
})
