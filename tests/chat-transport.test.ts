import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProjectChatTransport } from '@/lib/chat/transport'
import { setCloudAccount } from '@/lib/learning/cloud-request'

const userId = '550e8400-e29b-41d4-a716-446655440000'
beforeEach(() => { setCloudAccount(userId) })
afterEach(() => { setCloudAccount(undefined); vi.unstubAllGlobals() })

describe('account-bound chat transport', () => {
  it.each(['submit-message', 'regenerate-message'] as const)('sends only the latest user text for %s', async (trigger) => {
    const fetcher = vi.fn().mockResolvedValue(new Response('data: [DONE]\n\n'))
    vi.stubGlobal('fetch', fetcher)
    const transport = createProjectChatTransport('owned-project')
    await transport.sendMessages({ trigger, chatId: 'irrelevant', messageId: undefined, abortSignal: undefined,
      body: { projectId: 'forged-project', activityId: 'forged-activity', modelId: 'openai/gpt-5-nano', reasoningEffort: 'low' },
      messages: [
        { id: 'old', role: 'assistant', parts: [{ type: 'text', text: 'Do not send old history' }] },
        { id: 'new', role: 'user', parts: [{ type: 'text', text: 'Explain this' }, { type: 'data-report-errors', data: { summary: 'Not trusted input' } }] },
      ],
    })
    const init = fetcher.mock.calls[0][1] as RequestInit
    expect(new Headers(init.headers).get('X-CodeTutor-Account')).toBe(userId)
    expect(JSON.parse(String(init.body))).toEqual({ projectId: 'owned-project', message: { id: 'new', role: 'user', parts: [{ type: 'text', text: 'Explain this' }] }, modelId: 'openai/gpt-5-nano', reasoningEffort: 'low', retry: trigger === 'regenerate-message' })
  })

  it('does not send an old session using a different signed-in account', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const transport = createProjectChatTransport('owned-project')
    setCloudAccount('550e8400-e29b-41d4-a716-446655440001')
    await expect(transport.sendMessages({ trigger: 'submit-message', chatId: 'irrelevant', messageId: undefined, abortSignal: undefined,
      messages: [{ id: 'new', role: 'user', parts: [{ type: 'text', text: 'Explain this' }] }],
    })).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })
})
