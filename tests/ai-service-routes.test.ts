import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GatewayInternalServerError } from '@ai-sdk/gateway'
import { generateText } from 'ai'
import { POST as generateActivity } from '@/app/api/activities/generate/route'
import { POST as analyzeErrors } from '@/app/api/errors/route'
import { requireOwnedSandbox, requireUser } from '@/lib/server/api'
import { storeGeneratedActivity } from '@/lib/server/activities'

vi.mock('server-only', () => ({}))
vi.mock('@/app/api/errors/prompt', () => ({ default: 'Review errors.' }))
vi.mock('botid/server', () => ({ checkBotId: async () => ({ isBot: false }) }))
vi.mock('@/ai/gateway', () => ({ getModelOptions: vi.fn(() => ({ model: 'test' })) }))
vi.mock('ai', async (original) => ({ ...await original<typeof import('ai')>(), generateText: vi.fn() }))
vi.mock('@/lib/server/api', async (original) => ({ ...await original<typeof import('@/lib/server/api')>(), requireUser: vi.fn(), requireOwnedSandbox: vi.fn() }))
vi.mock('@/lib/server/rate-limit', () => ({ consumeQuota: async () => ({}) }))
vi.mock('@/lib/server/activities', () => ({ storeGeneratedActivity: vi.fn() }))

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.mocked(requireUser).mockResolvedValue({ user: { id: 'test-user' } } as never)
  vi.mocked(requireOwnedSandbox).mockResolvedValue({ sandbox_id: 'sbx_test' } as never)
  vi.mocked(generateText).mockRejectedValue(new GatewayInternalServerError({ statusCode: 402, message: 'private-provider-credential' }))
})
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks() })

describe('non-streaming AI routes during service credit exhaustion', () => {
  it.each([
    { name: 'activity generation', path: '/api/activities/generate', route: generateActivity, body: { mode: 'practice', goal: 'Understand loops', difficulty: 'beginner', language: 'JavaScript' } },
    { name: 'error analysis', path: '/api/errors', route: analyzeErrors, body: { sandboxId: 'sbx_test', lines: [{ command: 'node', args: [], stream: 'stderr', timestamp: 1, data: 'TypeError: cannot read property' }], previous: [] } },
  ])('returns service guidance instead of blaming learner input in $name', async ({ path, route, body }) => {
    const response = await route(new Request(`http://localhost${path}`, { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    expect(response.status).toBe(503)
    const payload = await response.json()
    expect(payload.error).toMatchObject({ code: 'AI_CREDITS_EXHAUSTED', requestId: expect.any(String) })
    expect(payload.error.message).toContain('out of credits')
    expect(JSON.stringify(payload)).not.toContain('private-')
    expect(response.headers.get('x-request-id')).toBe(payload.error.requestId)
    expect(storeGeneratedActivity).not.toHaveBeenCalled()
  })
})
