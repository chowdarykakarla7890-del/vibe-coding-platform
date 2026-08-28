import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from '@/app/api/errors/route'
import { ApiError, requireUser, requireOwnedSandbox } from '@/lib/server/api'
import { consumeQuota } from '@/lib/server/rate-limit'
import { generateText } from 'ai'
import { checkBotId } from 'botid/server'
vi.mock('server-only', () => ({}))
vi.mock('@/app/api/errors/prompt', () => ({ default: 'Review untrusted logs.' }))
vi.mock('@/ai/gateway', () => ({ getModelOptions: () => ({ model: 'gateway-test' }) }))
vi.mock('botid/server', () => ({ checkBotId: vi.fn() }))
vi.mock('ai', async original => ({ ...await original<object>(), generateText: vi.fn() }))
vi.mock('@/lib/server/api', async original => ({ ...await original<object>(), requireUser: vi.fn(), requireOwnedSandbox: vi.fn() }))
vi.mock('@/lib/server/rate-limit', () => ({ consumeQuota: vi.fn() }))
const line = { command: 'node', args: [], stream: 'stderr', data: 'TypeError: invalid input', timestamp: 1 }
const body = { sandboxId: 'owned-a', lines: [line], previous: [] }
const output = { shouldBeFixed: true, summary: 'Check main.ts', paths: ['main.ts'] }
function request(data: unknown = body, init?: RequestInit) {
  return new Request('http://localhost/api/errors', { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify(data), ...init })
}
beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.mocked(requireUser).mockResolvedValue({ user: { id: 'account-a' } } as never)
  vi.mocked(requireOwnedSandbox).mockResolvedValue({ sandbox_id: 'owned-a', status: 'running' } as never)
  vi.mocked(checkBotId).mockResolvedValue({ isBot: false } as never)
  vi.mocked(consumeQuota).mockResolvedValue({ 'X-RateLimit-Limit': '10' } as never)
  vi.mocked(generateText).mockResolvedValue({ output } as never)
})
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); vi.useRealTimers() })
describe('authenticated error analysis', () => {
  it('checks owned scope before skipping routine logs and consumes no AI quota', async () => {
    const response = await POST(request({ ...body, lines: [{ ...line, data: '100.64.0.1 - - [27/Aug/2026 23:42:18] "GET /error HTTP/1.1" 200 -' }], previous: [line] }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ shouldBeFixed: false, summary: '', paths: [] })
    expect(requireOwnedSandbox).toHaveBeenCalledWith('owned-a', expect.anything(), expect.any(AbortSignal))
    expect(generateText).not.toHaveBeenCalled()
    expect(consumeQuota).not.toHaveBeenCalled()
    expect(checkBotId).not.toHaveBeenCalled()
  })
  it('bounds provider output, disables retries and passes cancellation with quota headers', async () => {
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(output)
    expect(response.headers.get('x-ratelimit-limit')).toBe('10')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('x-request-id')).toBeTruthy()
    expect(consumeQuota).toHaveBeenCalledWith('account-a', 'ai-minute')
    expect(consumeQuota).toHaveBeenCalledWith('account-a', 'ai-day')
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({ model: 'gateway-test', maxRetries: 0, maxOutputTokens: 4096, abortSignal: expect.any(AbortSignal) }))
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain('invalid input')
  })
  it.each([401, 404, 410] as const)('refuses unauthorized/unavailable resources with %s', async status => {
    const error = new ApiError(status, 'DENIED', 'Unavailable')
    if (status === 401) vi.mocked(requireUser).mockRejectedValue(error)
    else vi.mocked(requireOwnedSandbox).mockRejectedValue(error)
    const response = await POST(request())
    expect(response.status).toBe(status)
    expect((await response.json()).error.requestId).toBe(response.headers.get('x-request-id'))
    expect(checkBotId).not.toHaveBeenCalled()
    expect(generateText).not.toHaveBeenCalled()
  })
  it.each([
    { init: { body: '{' }, status: 400 },
    { init: { headers: { origin: 'http://localhost', 'content-type': 'text/plain' } }, status: 415 },
    { init: { headers: { origin: 'https://evil.example', 'content-type': 'application/json' } }, status: 403 },
    { data: { ...body, sandboxId: '../other' }, status: 400 },
    { data: { ...body, modelId: 'expensive-override' }, status: 400 },
    { data: { ...body, lines: Array(101).fill(line) }, status: 400 },
    { data: { ...body, lines: [{ ...line, data: 'x'.repeat(140_000) }] }, status: 413 },
  ])('validates the complete request before the provider ($status)', async ({ init, data, status }) => {
    const response = await POST(request(data ?? body, init))
    expect(response.status).toBe(status)
    expect(generateText).not.toHaveBeenCalled()
  })
  it('rejects bot and quota failures without invoking the provider', async () => {
    vi.mocked(checkBotId).mockResolvedValueOnce({ isBot: true } as never)
    expect((await POST(request())).status).toBe(403)
    expect(consumeQuota).not.toHaveBeenCalled()
    vi.mocked(consumeQuota).mockRejectedValueOnce(new ApiError(429, 'RATE_LIMITED', 'Wait', { 'Retry-After': '60' }))
    const response = await POST(request())
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('60')
    expect(generateText).not.toHaveBeenCalled()
  })
  it.each([undefined, { ...output, summary: '' }, { ...output, summary: 'x'.repeat(8001) }, { ...output, paths: Array(21).fill('a') }])('rejects malformed or oversized provider results', async value => {
    vi.mocked(generateText).mockResolvedValue({ output: value } as never)
    const response = await POST(request())
    expect(response.status).toBe(502)
    expect((await response.json()).error.code).toBe('INVALID_ANALYSIS')
  })
  it.each(['authentication', 'bot verification', 'provider'] as const)('bounds stalled %s and prevents late work', async stage => {
    vi.useFakeTimers()
    let finish!: (value: unknown) => void
    const pending = new Promise(resolve => { finish = resolve })
    if (stage === 'authentication') vi.mocked(requireUser).mockReturnValue(pending as never)
    if (stage === 'bot verification') vi.mocked(checkBotId).mockReturnValue(pending as never)
    if (stage === 'provider') vi.mocked(generateText).mockReturnValue(pending as never)
    const task = POST(request())
    await vi.advanceTimersByTimeAsync(45_001)
    const response = await task
    expect(response.status).toBe(408)
    if (stage === 'provider') expect(vi.mocked(generateText).mock.calls[0][0].abortSignal?.aborted).toBe(true)
    finish(stage === 'authentication' ? { user: { id: 'account-a' } } : stage === 'bot verification' ? { isBot: false } : { output })
    await vi.advanceTimersByTimeAsync(0)
    if (stage !== 'provider') expect(generateText).not.toHaveBeenCalled()
  })
  it('cancels provider work when the client leaves and returns no late summary', async () => {
    vi.mocked(generateText).mockReturnValue(new Promise(() => {}) as never)
    const controller = new AbortController()
    const task = POST(request(body, { signal: controller.signal }))
    await vi.waitFor(() => expect(generateText).toHaveBeenCalledOnce())
    controller.abort()
    expect((await task).status).toBe(408)
    expect(vi.mocked(generateText).mock.calls[0][0].abortSignal?.aborted).toBe(true)
  })
})
