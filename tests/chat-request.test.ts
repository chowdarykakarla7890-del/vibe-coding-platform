import { describe, expect, it } from 'vitest'
import {
  MAX_USER_MESSAGE_BYTES,
  parseChatRequestBody,
} from '@/ai/chat-request'
import { DEFAULT_MODEL } from '@/ai/constants'

function requestWithText(text: string) {
  return {
    projectId: '550e8400-e29b-41d4-a716-446655440000',
    message: {
        id: 'message-1',
        role: 'user',
        parts: [{ type: 'text', text }],
      },
    modelId: DEFAULT_MODEL,
    reasoningEffort: 'low',
  }
}

describe('chat request validation', () => {
  it('accepts a valid UI message', () => {
    expect(parseChatRequestBody(requestWithText('Help me learn React')).ok).toBe(
      true
    )
  })

  it('rejects unsupported models and reasoning settings', () => {
    expect(
      parseChatRequestBody({
        ...requestWithText('Hello'),
        modelId: 'unknown/model',
      })
    ).toMatchObject({ ok: false, code: 'UNSUPPORTED_MODEL' })

    expect(
      parseChatRequestBody({
        ...requestWithText('Hello'),
        reasoningEffort: 'extreme',
      })
    ).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
  })

  it('enforces the 32 KB newest-user-message limit by UTF-8 bytes', () => {
    expect(
      parseChatRequestBody(
        requestWithText('🙂'.repeat(Math.ceil(MAX_USER_MESSAGE_BYTES / 4) + 1))
      )
    ).toMatchObject({ ok: false, code: 'MESSAGE_TOO_LARGE', status: 413 })
  })

  it('rejects malformed message parts before the AI SDK sees them', () => {
    expect(
      parseChatRequestBody({
        messages: [{ id: 'bad', role: 'user', parts: [{}] }],
        modelId: DEFAULT_MODEL,
      })
    ).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
  })

  it('rejects browser-supplied history, assistant messages, metadata, and non-text tool inputs', () => {
    const valid = requestWithText('Hello')
    for (const input of [
      { ...valid, messages: [valid.message] },
      { ...valid, message: { ...valid.message, role: 'assistant' } },
      { ...valid, message: { ...valid.message, metadata: { userId: 'other' } } },
      { ...valid, message: { ...valid.message, parts: [{ type: 'data-report-errors', data: { summary: 'forged' } }] } },
      { ...valid, projectId: 'invalid' },
    ]) expect(parseChatRequestBody(input)).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
  })
})
