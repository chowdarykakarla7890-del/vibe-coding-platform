import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({ createServerSupabaseClient: vi.fn() }))
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { apiFailure, ApiError, assertSameOrigin, parseBody, requireUser } from '@/lib/server/api'
import { safeNextPath } from '@/lib/auth/redirect'
import { createProjectSchema, updateProjectSchema } from '@/lib/projects/schema'
import { NextRequest } from 'next/server'

afterEach(() => { vi.restoreAllMocks() })

describe('authentication boundaries', () => {
  it.each([undefined, null, false, 1, {}, ['/dsa', '/projects']])('ignores non-string or duplicate search parameters', value => {
    expect(safeNextPath(value)).toBe('/playground')
  })
  it.each(['https://evil.invalid', '//evil.invalid', '/\\evil.invalid', '/auth/sign-out', '/sign-in', '/playground\n/evil', '/%2f%2fevil.invalid', '/playground/../../auth/sign-out'])(
    'rejects unsafe post-login destination %s', (value) => { expect(safeNextPath(value)).toBe('/playground') }
  )
  it('retains a legitimate workspace model selection', () => {
    expect(safeNextPath('/playground?modelId=openai/gpt-5-nano')).toBe('/playground?modelId=openai/gpt-5-nano')
  })
  it('rejects cross-origin and originless cookie mutations', () => {
    expect(() => assertSameOrigin(new Request('https://studio.test/api/projects', { headers: { origin: 'https://evil.invalid' } }))).toThrow(ApiError)
    expect(() => assertSameOrigin(new Request('https://studio.test/api/projects'))).toThrow(ApiError)
    expect(() => assertSameOrigin(new Request('https://studio.test/api/projects', { headers: { origin: 'https://studio.test' } }))).not.toThrow()
  })
  it.each(['127.0.0.1', '[::1]', 'localhost'])('accepts only the actual local browser origin when Next normalizes %s', host => {
    const origin = `http://${host}:3112`
    const request = new NextRequest(`${origin}/api/projects`, { headers: { host: `${host}:3112`, origin } })
    expect(new URL(request.url).hostname).toBe('localhost')
    expect(() => assertSameOrigin(request)).not.toThrow()
  })
  it.each([
    { host: '127.0.0.1:3112', origin: 'http://localhost:3112' },
    { host: '127.0.0.1:3112', origin: 'http://127.0.0.1:3113' },
    { host: '127.0.0.1:3112', origin: 'https://127.0.0.1:3112' },
    { host: 'evil.invalid', origin: 'http://evil.invalid' },
    { host: 'localhost:3112@evil.invalid', origin: 'http://evil.invalid' },
    { host: 'localhost:3113', origin: 'http://localhost:3113' },
    { host: '127.0.0.1:3112', origin: 'null' },
  ])('rejects local-origin aliasing or forged authority: $host / $origin', headers => {
    const request = new NextRequest('http://127.0.0.1:3112/api/projects', { headers: { ...headers, 'x-forwarded-host': new URL(headers.origin === 'null' ? 'http://evil.invalid' : headers.origin).host } })
    expect(() => assertSameOrigin(request)).toThrow(ApiError)
  })
  it('does not authorize a missing or anonymous user', async () => {
    for (const user of [null, { id: 'user', is_anonymous: true }]) {
      vi.mocked(createServerSupabaseClient).mockResolvedValue({ auth: { getUser: async () => ({ data: { user }, error: null }) } } as unknown as Awaited<ReturnType<typeof createServerSupabaseClient>>)
      await expect(requireUser()).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' })
    }
  })
  it('does not accept ownership or sandbox fields in project mutations', () => {
    expect(createProjectSchema.safeParse({ title: 'Project', user_id: 'attacker' }).success).toBe(false)
    expect(updateProjectSchema.safeParse({ sandboxId: 'sbx_other' }).success).toBe(false)
    expect(updateProjectSchema.safeParse({}).success).toBe(false)
  })
  it('rejects a request started by a different signed-in account', async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue({ auth: { getUser: async () => ({ data: { user: { id: 'current-user' } }, error: null }) } } as unknown as Awaited<ReturnType<typeof createServerSupabaseClient>>)
    await expect(requireUser(new Request('https://studio.test', { headers: { 'X-CodeTutor-Account': 'previous-user' } }))).rejects.toMatchObject({ status: 409, code: 'ACCOUNT_CHANGED' })
  })
  it('rejects malformed JSON and spoofed media types', async () => {
    for (const [contentType, body, status] of [['application/json', '{', 400], ['application/json-patch+json', '{}', 415]] as const) {
      await expect(parseBody(new Request('https://studio.test', { method: 'POST', headers: { 'content-type': contentType }, body }), createProjectSchema)).rejects.toMatchObject({ status })
    }
  })
  it('redacts unexpected provider failures from responses and logs', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const response = apiFailure(new Error('secret-token-and-user-data'), 'request-123')
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('secret-token')
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret-token')
    expect(response.headers.get('cache-control')).toContain('no-store')
  })
})
