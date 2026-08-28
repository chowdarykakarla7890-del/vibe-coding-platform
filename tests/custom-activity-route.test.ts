import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { POST } from '@/app/api/activities/generate/route'
import { ApiError, requireUser } from '@/lib/server/api'
import { consumeQuota } from '@/lib/server/rate-limit'
import { storeGeneratedActivity } from '@/lib/server/activities'
import { checkBotId } from 'botid/server'
import { generateText } from 'ai'
import { ACTIVITY_GENERATION_TIMEOUT_MS } from '@/lib/learning/activity-generation'
import { DEFAULT_MODEL } from '@/ai/constants'
import { getModelOptions } from '@/ai/gateway'

vi.mock('server-only', () => ({}))
vi.mock('@/ai/gateway', () => ({ getModelOptions: vi.fn(() => ({ model: 'test-gateway' })) }))
vi.mock('botid/server', () => ({ checkBotId: vi.fn() }))
vi.mock('ai', async original => ({ ...await original<object>(), generateText: vi.fn() }))
vi.mock('@/lib/server/api', async original => ({ ...await original<object>(), requireUser: vi.fn() }))
vi.mock('@/lib/server/rate-limit', () => ({ consumeQuota: vi.fn() }))
vi.mock('@/lib/server/activities', async original => ({ ...await original<object>(), storeGeneratedActivity: vi.fn() }))

const auth = { user: { id: '11111111-1111-4111-8111-111111111111' } }
const body = { mode: 'practice', goal: 'Understand private-learning-goal', language: 'TypeScript', difficulty: 'beginner' }
const quotaHeaders = { 'X-RateLimit-Limit': '10', 'X-RateLimit-Remaining': '9', 'X-RateLimit-Reset': '60' }
const output = {
  mode: 'practice', title: 'Loop practice', summary: 'Understand counting with loops.', language: 'TypeScript', difficulty: 'beginner',
  concepts: ['loops'], estimatedMinutes: 15, instructions: ['Complete the counting function.'],
  starterFiles: [{ path: 'main.ts', content: '// private-learner-source' }],
  verify: { kind: 'command', command: { executable: 'node', args: ['main.ts'] } },
  rubric: [{ id: 'correctness', label: 'Correct result', weight: 100 }],
}
function request(data: unknown = body, init?: RequestInit) {
  return new Request('http://localhost/api/activities/generate', { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify(data), ...init })
}
beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.mocked(requireUser).mockResolvedValue(auth as never)
  vi.mocked(checkBotId).mockResolvedValue({ isBot: false } as never)
  vi.mocked(consumeQuota).mockResolvedValue(quotaHeaders)
  vi.mocked(generateText).mockResolvedValue({ output } as never)
  vi.mocked(storeGeneratedActivity).mockResolvedValue(undefined)
})
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); vi.useRealTimers() })

it('validates, protects, bounds and saves one generated manifest under its originating account', async () => {
  const response = await POST(request())
  expect(response.status).toBe(200)
  const payload = await response.json()
  expect(payload.activity).toMatchObject({ mode: 'practice', source: 'generated', id: expect.stringMatching(/^generated-practice-/) })
  expect(storeGeneratedActivity).toHaveBeenCalledExactlyOnceWith(auth, payload.activity)
  expect(checkBotId).toHaveBeenCalledOnce()
  expect(consumeQuota).toHaveBeenNthCalledWith(1, auth.user.id, 'ai-minute')
  expect(consumeQuota).toHaveBeenNthCalledWith(2, auth.user.id, 'ai-day')
  expect(getModelOptions).toHaveBeenCalledWith(DEFAULT_MODEL)
  expect(generateText).toHaveBeenCalledWith(expect.objectContaining({ abortSignal: expect.any(AbortSignal), maxRetries: 0, maxOutputTokens: 16_384 }))
  expect(response.headers.get('x-request-id')).toBe(payload.requestId)
  expect(response.headers.get('x-ratelimit-limit')).toBe('10')
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain('private-')
})

it('uses requested mode/difficulty and downgrades disallowed verification to rubric-only', async () => {
  vi.mocked(generateText).mockResolvedValue({ output: { ...output, mode: 'dsa', difficulty: 'advanced', verify: { kind: 'command', command: { executable: 'bash', args: ['-c', 'unsafe'] } }, variants: { Python: { starterFiles: [{ path: 'main.py', content: '# TODO' }], verify: { kind: 'command', command: { executable: 'bash', args: [] } } } } } } as never)
  const payload = await (await POST(request())).json()
  expect(payload.activity).toMatchObject({ mode: 'practice', difficulty: 'beginner', verify: { kind: 'rubric' }, variants: { Python: { verify: { kind: 'rubric' } } } })
})

it.each([
  { init: { body: '{' }, status: 400 },
  { init: { headers: { origin: 'http://localhost', 'content-type': 'text/plain' } }, status: 415 },
  { init: { headers: { origin: 'https://evil.example', 'content-type': 'application/json' } }, status: 403 },
  { data: { ...body, mode: 'playground' }, status: 400 },
  { data: { ...body, goal: '     ' }, status: 400 },
  { data: { ...body, goal: 'x'.repeat(801) }, status: 400 },
  { data: { ...body, language: '  ' }, status: 400 },
  { data: { ...body, modelId: 'unsupported/model' }, status: 400 },
  { data: { ...body, userId: 'another-account' }, status: 400 },
  { data: { ...body, extra: 'x'.repeat(9000) }, status: 413 },
])('rejects malformed requests before BotID, quotas, generation and storage ($status)', async ({ data, init, status }) => {
  const response = await POST(request(data ?? body, init))
  expect(response.status).toBe(status)
  expect((await response.json()).error.requestId).toBe(response.headers.get('x-request-id'))
  expect(checkBotId).not.toHaveBeenCalled()
  expect(consumeQuota).not.toHaveBeenCalled()
  expect(generateText).not.toHaveBeenCalled()
  expect(storeGeneratedActivity).not.toHaveBeenCalled()
})

it('refuses anonymous, bot and exhausted-quota requests before paid generation', async () => {
  vi.mocked(requireUser).mockRejectedValueOnce(new ApiError(401, 'AUTH_REQUIRED', 'Sign in'))
  expect((await POST(request())).status).toBe(401)
  expect(checkBotId).not.toHaveBeenCalled()
  vi.mocked(checkBotId).mockResolvedValueOnce({ isBot: true } as never)
  expect((await POST(request())).status).toBe(403)
  expect(consumeQuota).not.toHaveBeenCalled()
  vi.mocked(consumeQuota).mockRejectedValueOnce(new ApiError(429, 'RATE_LIMITED', 'Wait', { 'Retry-After': '60' }))
  const response = await POST(request())
  expect(response.status).toBe(429)
  expect(response.headers.get('retry-after')).toBe('60')
  expect(generateText).not.toHaveBeenCalled()
  expect(storeGeneratedActivity).not.toHaveBeenCalled()
})

it.each([
  undefined,
  { ...output, starterFiles: [{ path: '../secret', content: 'unsafe' }] },
  { ...output, starterFiles: [{ path: 'main.ts', content: 'x'.repeat(256 * 1024 + 1) }] },
  { ...output, rubric: [{ id: 'bad', label: 'Bad total', weight: 40 }] },
  { ...output, setup: { executable: 'bash', args: ['-c', 'unsafe'] } },
])('rejects invalid manifests before storage', async value => {
  vi.mocked(generateText).mockResolvedValue({ output: value } as never)
  const response = await POST(request())
  expect(response.status).toBe(502)
  expect((await response.json()).error.code).toBe('INVALID_ACTIVITY')
  expect(storeGeneratedActivity).not.toHaveBeenCalled()
})

it('does not misreport storage failures as invalid learner input', async () => {
  vi.mocked(storeGeneratedActivity).mockRejectedValue(new Error('private-database-details'))
  const response = await POST(request())
  expect(response.status).toBe(502)
  const payload = await response.json()
  expect(payload.error.code).toBe('UPSTREAM_ERROR')
  expect(JSON.stringify(payload)).not.toContain('private-')
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('private-')
})

it.each(['authentication', 'bot', 'minute quota', 'daily quota', 'provider', 'storage'])('bounds stalled %s and prevents late follow-on work', async stage => {
  vi.useFakeTimers()
  let finish!: (value: unknown) => void
  const pending = new Promise(resolve => { finish = resolve })
  if (stage === 'authentication') vi.mocked(requireUser).mockReturnValue(pending as never)
  if (stage === 'bot') vi.mocked(checkBotId).mockReturnValue(pending as never)
  if (stage === 'minute quota') vi.mocked(consumeQuota).mockReturnValueOnce(pending as never)
  if (stage === 'daily quota') vi.mocked(consumeQuota).mockResolvedValueOnce(quotaHeaders).mockReturnValueOnce(pending as never)
  if (stage === 'provider') vi.mocked(generateText).mockReturnValue(pending as never)
  if (stage === 'storage') vi.mocked(storeGeneratedActivity).mockReturnValue(pending as never)
  const task = POST(request())
  await vi.advanceTimersByTimeAsync(ACTIVITY_GENERATION_TIMEOUT_MS + 1)
  const response = await task
  expect(response.status).toBe(408)
  expect((await response.json()).error.code).toBe('GENERATION_INTERRUPTED')
  finish(stage === 'authentication' ? auth : stage === 'bot' ? { isBot: false } : stage === 'provider' ? { output } : {})
  await vi.advanceTimersByTimeAsync(0)
  if (stage !== 'provider' && stage !== 'storage') expect(generateText).not.toHaveBeenCalled()
  if (stage !== 'storage') expect(storeGeneratedActivity).not.toHaveBeenCalled()
  else expect(storeGeneratedActivity).toHaveBeenCalledOnce() // A started write is not retried or undone.
  expect(vi.mocked(console.info).mock.calls.some(args => args[1]?.outcome === 'complete')).toBe(false)
})

it('cancels provider work before storage and ignores its late successful response', async () => {
  let finish!: (value: unknown) => void
  vi.mocked(generateText).mockReturnValue(new Promise(resolve => { finish = resolve }) as never)
  const controller = new AbortController()
  const task = POST(request(body, { signal: controller.signal }))
  await vi.waitFor(() => expect(generateText).toHaveBeenCalledOnce())
  controller.abort()
  expect((await task).status).toBe(408)
  expect(vi.mocked(generateText).mock.calls[0][0].abortSignal?.aborted).toBe(true)
  finish({ output })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(storeGeneratedActivity).not.toHaveBeenCalled()
})
