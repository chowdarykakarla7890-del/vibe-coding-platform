import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GET, POST } from '@/app/api/sandboxes/[sandboxId]/preview/route'
import { ApiError, requireUser } from '@/lib/server/api'
import { readOwnedSandboxPreview, connectOwnedSandboxPreview } from '@/lib/server/sandbox'
import { consumeQuota } from '@/lib/server/rate-limit'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({}))
vi.mock('@/lib/server/api', async original => ({ ...await original<typeof import('@/lib/server/api')>(), requireUser: vi.fn() }))
vi.mock('@/lib/server/sandbox', () => ({ readOwnedSandboxPreview: vi.fn(), connectOwnedSandboxPreview: vi.fn() }))
vi.mock('@/lib/server/rate-limit', () => ({ consumeQuota: vi.fn() }))
const projectId = '11111111-1111-4111-8111-111111111111'
const receipt = { projectId, sandboxId: 'owned', url: 'https://sb-owned.vercel.run', port: 3000, ports: [3000, 8000] }
const context = { params: Promise.resolve({ sandboxId: 'owned' }) }
function request(method = 'GET', value: unknown = { projectId }, origin = 'http://localhost') {
  return new Request(`http://localhost/api/sandboxes/owned/preview${method === 'GET' ? `?${value}` : ''}`, {
    method, headers: { origin, 'content-type': 'application/json' },
    ...(method !== 'GET' ? { body: typeof value === 'string' ? value : JSON.stringify(value) } : {}),
  })
}
beforeEach(() => {
  vi.mocked(requireUser).mockResolvedValue({ user: { id: 'owner' } } as never)
  vi.mocked(readOwnedSandboxPreview).mockResolvedValue(receipt)
  vi.mocked(connectOwnedSandboxPreview).mockResolvedValue(receipt)
  vi.mocked(consumeQuota).mockResolvedValue({ 'X-RateLimit-Limit': '60', 'X-RateLimit-Remaining': '59', 'X-RateLimit-Reset': '123' })
})
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers() })

describe('authenticated preview API', () => {
  it('returns a noncached, rate-limited read without persisting or invoking AI', async () => {
    const response = await GET(request('GET', `projectId=${projectId}`), context)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject(receipt)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('x-request-id')).toBeTruthy()
    expect(response.headers.get('x-ratelimit-remaining')).toBe('59')
    expect(readOwnedSandboxPreview).toHaveBeenCalledWith(expect.objectContaining({ user: { id: 'owner' } }), 'owned', projectId, undefined, expect.any(AbortSignal))
    expect(connectOwnedSandboxPreview).not.toHaveBeenCalled()
  })
  it('persists only a validated explicit port selection', async () => {
    expect((await POST(request('POST', { projectId, port: 8000 }), context)).status).toBe(200)
    expect(connectOwnedSandboxPreview).toHaveBeenCalledWith(expect.anything(), 'owned', projectId, 8000, expect.any(AbortSignal))
    expect(readOwnedSandboxPreview).not.toHaveBeenCalled()
  })
  it.each(['', 'projectId=bad', `projectId=${projectId}&port=80`, `projectId=${projectId}&port=1e3`, `projectId=${projectId}&port=`, `projectId=${projectId}&port=3000&port=8000`, `projectId=${projectId}&url=https://evil.example`])('rejects invalid query %s', async query => {
    expect((await GET(request('GET', query), context)).status).toBe(400)
    expect(readOwnedSandboxPreview).not.toHaveBeenCalled()
    expect(consumeQuota).not.toHaveBeenCalled()
  })
  it.each(['{', { projectId, port: '3000' }, { projectId, port: 65536 }, { projectId, url: 'https://evil.example' }])('rejects malformed or forged POST fields', async value => {
    expect((await POST(request('POST', value), context)).status).toBe(400)
    expect(connectOwnedSandboxPreview).not.toHaveBeenCalled()
  })
  it('rejects invalid route IDs and request content types', async () => {
    expect((await GET(request('GET', `projectId=${projectId}`), { params: Promise.resolve({ sandboxId: '../other' }) })).status).toBe(400)
    const req = request('POST'); req.headers.set('content-type', 'text/plain')
    expect((await POST(req, context)).status).toBe(415)
    expect(connectOwnedSandboxPreview).not.toHaveBeenCalled()
  })
  it('refuses cross-origin writes', async () => {
    expect((await POST(request('POST', { projectId }, 'https://evil.example'), context)).status).toBe(403)
    expect(connectOwnedSandboxPreview).not.toHaveBeenCalled()
  })
  it('requires a real user before reading a sandbox', async () => {
    vi.mocked(requireUser).mockRejectedValue(new ApiError(401, 'AUTH_REQUIRED', 'Sign in.'))
    const response = await GET(request('GET', `projectId=${projectId}`), context)
    expect(response.status).toBe(401)
    expect(readOwnedSandboxPreview).not.toHaveBeenCalled()
  })
  it.each([404, 410])('preserves expected ownership/expiry status %s', async status => {
    vi.mocked(readOwnedSandboxPreview).mockRejectedValue(new ApiError(status, 'SANDBOX_UNAVAILABLE', 'Unavailable.'))
    const response = await GET(request('GET', `projectId=${projectId}`), context)
    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({ error: { requestId: expect.any(String) } })
  })
  it('stops at quota rejection', async () => {
    vi.mocked(consumeQuota).mockRejectedValue(new ApiError(429, 'RATE_LIMITED', 'Wait.', { 'Retry-After': '60' }))
    const response = await GET(request('GET', `projectId=${projectId}`), context)
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('60')
    expect(readOwnedSandboxPreview).not.toHaveBeenCalled()
  })
  it('bounds an authentication read that never settles', async () => {
    vi.useFakeTimers()
    vi.mocked(requireUser).mockReturnValue(new Promise(() => {}))
    const response = GET(request('GET', `projectId=${projectId}`), context)
    await vi.advanceTimersByTimeAsync(30_001)
    expect((await response).status).toBe(408)
    expect(readOwnedSandboxPreview).not.toHaveBeenCalled()
  })
})
