import { afterEach, expect, it, vi } from 'vitest'
import { fetchSignInMethods, oauthRedirectUrl, signInReadinessIssues } from '@/lib/auth/sign-in-methods'

const config = { supabaseUrl: 'https://auth.example', publishableKey: 'sb_publishable_test' }
const settings = { external: { email: true, github: true, google: false }, disable_signup: false }
const callback = 'https://studio.example/auth/callback?next=%2Fdsa'
function authorize(provider = 'github') {
  const url = new URL('/auth/v1/authorize', config.supabaseUrl)
  url.searchParams.set('provider', provider)
  url.searchParams.set('redirect_to', callback)
  return url.toString()
}
afterEach(() => vi.unstubAllGlobals())

it('reads only public settings without forwarding cookies or following redirects', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ ...settings, sensitiveUnexpectedField: 'must-not-be-returned' }))
  vi.stubGlobal('fetch', fetcher)
  const signal = new AbortController().signal
  expect(await fetchSignInMethods(config, signal)).toEqual({ email: true, github: true, google: false, signupDisabled: false })
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://auth.example/auth/v1/settings', {
    headers: { apikey: config.publishableKey }, signal, cache: 'no-store', credentials: 'omit', redirect: 'error',
  })
})

it.each([{}, null, { external: {} }, { ...settings, external: { ...settings.external, google: 'true' } }, { ...settings, disable_signup: undefined }])('rejects incomplete or invalid provider settings', async payload => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(payload)))
  await expect(fetchSignInMethods(config, new AbortController().signal)).rejects.toThrow('invalid settings')
})

it('does not expose raw upstream errors', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('private-provider-details', { status: 502 })))
  await expect(fetchSignInMethods(config, new AbortController().signal)).rejects.toThrow('Sign-in methods could not be loaded. Please retry.')
})

it.each(['https://user:pass@auth.example', 'http://auth.example', 'https://auth.example/wrong', 'https://auth.example?secret=value', 'javascript:alert(1)'])('rejects unsafe configured origin: %s', async supabaseUrl => {
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  await expect(fetchSignInMethods({ ...config, supabaseUrl }, new AbortController().signal)).rejects.toThrow()
  expect(fetcher).not.toHaveBeenCalled()
})

it('rejects a server-only secret in the public key setting before sending it', async () => {
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  await expect(fetchSignInMethods({ ...config, publishableKey: 'sb_secret_do-not-send' }, new AbortController().signal)).rejects.toThrow()
  expect(fetcher).not.toHaveBeenCalled()
})

it('allows the local Supabase HTTP origin used in isolated CI', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(settings)))
  await expect(fetchSignInMethods({ ...config, supabaseUrl: 'http://127.0.0.1:54321' }, new AbortController().signal)).resolves.toMatchObject({ email: true })
})

it('rejects already-cancelled and late provider reads', async () => {
  const controller = new AbortController(), fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  controller.abort()
  await expect(fetchSignInMethods(config, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(fetcher).not.toHaveBeenCalled()
  const active = new AbortController()
  fetcher.mockImplementation(async () => { active.abort(); return Response.json(settings) })
  await expect(fetchSignInMethods(config, active.signal)).rejects.toMatchObject({ name: 'AbortError' })
})

it.each(['github', 'google'] as const)('accepts the configured %s authorization endpoint and exact callback', provider => {
  expect(oauthRedirectUrl(authorize(provider), provider, callback, config)).toBe(authorize(provider))
})

it.each([
  null, '', 'javascript:alert(1)', 'https://evil.invalid/auth/v1/authorize',
  authorize().replace('/authorize', '/token'), authorize().replace('auth.example', 'auth.example.evil.invalid'),
  authorize().replace('https://', 'https://user:pass@'), `${authorize()}#fragment`, `${authorize()}&provider=google`,
  authorize('google'), `${authorize()}&redirect_to=https://evil.invalid`, authorize().replace('dsa', 'playground'),
])('rejects an unrelated or ambiguous OAuth destination', value => {
  expect(() => oauthRedirectUrl(value, 'github', callback, config)).toThrow()
})

it('requires all promised methods and open registration for the release preflight', () => {
  expect(signInReadinessIssues({ email: true, github: true, google: false, signupDisabled: false })).toEqual(['GOOGLE_DISABLED'])
  expect(signInReadinessIssues({ email: false, github: false, google: true, signupDisabled: true })).toEqual(['EMAIL_DISABLED', 'GITHUB_DISABLED', 'REGISTRATION_DISABLED'])
  expect(signInReadinessIssues({ email: true, github: true, google: true, signupDisabled: false })).toEqual([])
})
