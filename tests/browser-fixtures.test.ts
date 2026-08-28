import { expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { assertBrowserCiEnvironment, localEmailVerificationLink } from '@/scripts/browser-fixtures.mjs'

const env = { CI: 'true', GITHUB_ACTIONS: 'true', TEST_APP_URL: 'http://127.0.0.1:3115', NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SECRET_KEY: 'fixture', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'fixture' }
it('permits only disposable CI, fixed loopback services and no paid credentials', () => {
  expect(() => assertBrowserCiEnvironment(env, ['.env.example'])).not.toThrow()
  for (const change of [{ CI: 'false' }, { GITHUB_ACTIONS: 'false' }, { TEST_APP_URL: 'https://codetutor-studio.vercel.app' }, { NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co' }, { AI_GATEWAY_API_KEY: 'fixture' }, { SUPABASE_SECRET_KEY: '' }]) {
    expect(() => assertBrowserCiEnvironment({ ...env, ...change }, [])).toThrow()
  }
  expect(() => assertBrowserCiEnvironment(env, ['.env.local'])).toThrow()
})
it('accepts only the recipient-specific local PKCE email link with the requested callback', () => {
  const email = 'codetutor-browser-12345678-abcd-abcd-abcd-123456789abc-a@example.invalid'
  const callback = new URL('/auth/callback', env.TEST_APP_URL)
  callback.searchParams.set('next', '/playground?modelId=openai/gpt-5-nano')
  const link = new URL('/auth/v1/verify', env.NEXT_PUBLIC_SUPABASE_URL)
  link.searchParams.set('token', 'fixture-only')
  link.searchParams.set('type', 'magiclink')
  link.searchParams.set('redirect_to', callback.href)
  const message = { To: [{ Address: email }], HTML: `<a href="${link.href.replaceAll('&', '&amp;')}">Sign in</a>` }
  expect(localEmailVerificationLink(message, email, '/playground?modelId=openai/gpt-5-nano')).toBe(link.href)
  expect(() => localEmailVerificationLink(message, email, '/dsa')).toThrow()
  expect(() => localEmailVerificationLink({ ...message, To: [] }, email, '/playground')).toThrow()
  expect(() => localEmailVerificationLink({ ...message, HTML: message.HTML.replace('127.0.0.1:54321', 'evil.invalid') }, email, '/playground?modelId=openai/gpt-5-nano')).toThrow()
})
it('refuses to launch a browser or create accounts outside disposable CI', () => {
  const result = spawnSync(process.execPath, ['scripts/ci-browser.mjs'], { encoding: 'utf8', timeout: 5000,
    env: { ...process.env, CI: 'true', GITHUB_ACTIONS: 'false' } })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('require disposable GitHub CI')
})
