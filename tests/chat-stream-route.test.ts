import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
import type { ChatUIMessage } from '@/components/chat/types'
import { POST } from '@/app/api/chat/route'
import { getModelOptions } from '@/ai/gateway'
import { beginChatTurn, loadAuthoritativeHistory, saveAssistantTurn } from '@/lib/server/chat'
import { requireOwnedProject, requireUser } from '@/lib/server/api'
import { GatewayInternalServerError } from '@ai-sdk/gateway'

vi.mock('server-only', () => ({}))
vi.mock('@/app/api/chat/prompt', () => ({ default: 'Teach programming.' }))
vi.mock('@/ai/gateway', () => ({ getModelOptions: vi.fn() }))
vi.mock('@/ai/tools', () => ({ tools: () => ({}) }))
vi.mock('botid/server', () => ({ checkBotId: async () => ({ isBot: false }) }))
vi.mock('@/lib/server/chat', () => ({ beginChatTurn: vi.fn(), loadAuthoritativeHistory: vi.fn(), saveAssistantTurn: vi.fn() }))
vi.mock('@/lib/server/rate-limit', () => ({ consumeQuota: async () => ({ 'X-RateLimit-Limit': '10' }) }))
vi.mock('@/lib/server/api', async (original) => ({ ...await original<object>(), requireUser: vi.fn(), requireOwnedProject: vi.fn() }))
const afterTasks = vi.hoisted(() => [] as Promise<unknown>[])
vi.mock('next/server', async (original) => ({ ...await original<object>(), after: (callback: () => unknown) => { afterTasks.push(Promise.resolve().then(callback)) } }))

const projectId = '550e8400-e29b-41d4-a716-446655440000'
const assistantId = 'server-assistant'
const savedUser: ChatUIMessage = { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Explain a loop' }] }
const finish: LanguageModelV3StreamPart = { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
} }

function request(signal?: AbortSignal) {
  return new Request('http://localhost/api/chat', { method: 'POST', signal, headers: { origin: 'http://localhost', 'content-type': 'application/json' },
    body: JSON.stringify({ projectId, message: savedUser, modelId: 'openai/gpt-5-nano' }),
  })
}
function provider() {
  let controller!: ReadableStreamDefaultController<LanguageModelV3StreamPart>
  let closed = false
  let detach = () => {}
  const model = new MockLanguageModelV3({ doStream: async ({ abortSignal }) => ({ stream: new ReadableStream({
    start(value) {
      controller = value
      const abort = () => { if (!closed) { closed = true; controller.error(abortSignal!.reason) } }
      abortSignal?.addEventListener('abort', abort, { once: true })
      detach = () => abortSignal?.removeEventListener('abort', abort)
      if (abortSignal?.aborted) abort()
    },
    cancel() { closed = true; detach() },
  }) }) })
  vi.mocked(getModelOptions).mockReturnValue({ model })
  return { model, emit: (...parts: LanguageModelV3StreamPart[]) => parts.forEach((part) => { if (!closed) controller.enqueue(part) }), close: () => { if (!closed) { closed = true; detach(); controller.close() } } }
}
function complete(output: ReturnType<typeof provider>) {
  output.emit({ type: 'text-start', id: 'text' }, { type: 'text-delta', id: 'text', delta: 'A loop repeats work.' }, { type: 'text-end', id: 'text' }, finish)
  output.close()
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const query = { eq: () => query, gt: () => query, limit: async () => ({ data: [], error: null }) }
  vi.mocked(requireUser).mockResolvedValue({ user: { id: 'account-a' }, supabase: { from: () => ({ select: () => query }) } } as never)
  vi.mocked(requireOwnedProject).mockResolvedValue({ id: projectId, activity_id: null } as never)
  vi.mocked(beginChatTurn).mockResolvedValue(assistantId)
  vi.mocked(loadAuthoritativeHistory).mockResolvedValue([savedUser])
  vi.mocked(saveAssistantTurn).mockResolvedValue(undefined)
})
afterEach(async () => { await Promise.allSettled(afterTasks.splice(0)); vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks() })

describe('durable chat route with the real AI SDK stream processor', () => {
  it('reports exhausted Gateway credits without exposing provider details or leaving a pending turn', async () => {
    const output = provider()
    const response = await POST(request())
    const body = response.text()
    await vi.waitFor(() => expect(output.model.doStreamCalls).toHaveLength(1))
    output.emit({ type: 'error', error: new GatewayInternalServerError({ statusCode: 402, message: 'private-provider-key and billing details' }) })
    output.close()
    const text = await body
    expect(text).toContain('out of credits')
    expect(text).not.toContain('private-provider')
    expect(console.error).toHaveBeenCalledWith('Chat request failed', expect.objectContaining({ code: 'AI_CREDITS_EXHAUSTED', upstreamStatus: 402 }))
    expect(saveAssistantTurn).toHaveBeenLastCalledWith(expect.anything(), projectId, assistantId, expect.any(String), expect.anything(), 'failed')
  })
  it('sends the reserved assistant ID immediately and persists the completed message', async () => {
    const output = provider()
    const response = await POST(request())
    const reader = response.body!.getReader()
    const start = new TextDecoder().decode((await reader.read()).value)
    expect(start).toContain(assistantId)
    expect(start).not.toContain('A loop repeats work.')
    expect(response.headers.get('x-ratelimit-limit')).toBe('10')
    await vi.waitFor(() => expect(output.model.doStreamCalls).toHaveLength(1))
    complete(output)
    while (!(await reader.read()).done) { /* consume */ }
    expect(saveAssistantTurn).toHaveBeenLastCalledWith(expect.anything(), projectId, assistantId, expect.any(String), expect.objectContaining({
      id: assistantId, role: 'assistant', parts: expect.arrayContaining([expect.objectContaining({ type: 'text', text: 'A loop repeats work.' })]),
    }), 'complete')
    expect(output.model.doStreamCalls[0].prompt.at(-1)).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'Explain a loop' }] })
    expect(savedUser.parts).toEqual([{ type: 'text', text: 'Explain a loop' }])
  })

  it('waits for the outstanding heartbeat before final persistence', async () => {
    vi.useFakeTimers()
    const output = provider()
    let release!: () => void
    vi.mocked(saveAssistantTurn).mockImplementation(async (_auth, _project, _assistant, _request, message) => {
      if (!message) await new Promise<void>((resolve) => { release = resolve })
    })
    const response = await POST(request())
    const body = response.text()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(release).toBeTypeOf('function')
    complete(output)
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.mocked(saveAssistantTurn).mock.calls.some((call) => call[5] === 'complete')).toBe(false)
    release()
    await body
    expect(saveAssistantTurn).toHaveBeenLastCalledWith(expect.anything(), projectId, assistantId, expect.any(String), expect.anything(), 'complete')
    expect(output.model.doStreamCalls[0].abortSignal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(90_000)
    expect(output.model.doStreamCalls[0].abortSignal?.aborted).toBe(false)
  })

  it('saves an interrupted state on Stop instead of leaving a pending turn', async () => {
    const output = provider()
    const cancellation = new AbortController()
    const response = await POST(request(cancellation.signal))
    const body = response.text()
    await vi.waitFor(() => expect(output.model.doStreamCalls).toHaveLength(1))
    cancellation.abort()
    await body
    expect(saveAssistantTurn).toHaveBeenLastCalledWith(expect.anything(), projectId, assistantId, expect.any(String), expect.anything(), 'interrupted')
  })

  it('times out an idle stream and stops heartbeats', async () => {
    vi.useFakeTimers()
    const output = provider()
    const response = await POST(request())
    const body = response.text()
    await vi.advanceTimersByTimeAsync(90_000)
    await body
    expect(output.model.doStreamCalls[0].abortSignal?.aborted).toBe(true)
    expect(saveAssistantTurn).toHaveBeenLastCalledWith(expect.anything(), projectId, assistantId, expect.any(String), expect.anything(), 'interrupted')
    const calls = vi.mocked(saveAssistantTurn).mock.calls.length
    await vi.advanceTimersByTimeAsync(40_000)
    expect(saveAssistantTurn).toHaveBeenCalledTimes(calls)
  })

  it('redacts provider failures and marks the response failed', async () => {
    const output = provider()
    const response = await POST(request())
    const body = response.text()
    await vi.waitFor(() => expect(output.model.doStreamCalls).toHaveLength(1))
    output.emit({ type: 'error', error: new Error('secret-provider-credential') })
    output.close()
    const text = await body
    expect(text).not.toContain('secret-provider-credential')
    expect(text).toContain('could not finish')
    expect(saveAssistantTurn).toHaveBeenLastCalledWith(expect.anything(), projectId, assistantId, expect.any(String), expect.anything(), 'failed')
  })

  it('settles a reserved turn when loading its history fails before streaming', async () => {
    vi.mocked(loadAuthoritativeHistory).mockRejectedValue(new Error('private database detail'))
    const response = await POST(request())
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('private database detail')
    expect(saveAssistantTurn).toHaveBeenLastCalledWith(expect.anything(), projectId, assistantId, expect.any(String), undefined, 'failed')
    expect(getModelOptions).not.toHaveBeenCalled()
  })
})
