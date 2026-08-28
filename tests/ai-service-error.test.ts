import { afterEach, describe, expect, it, vi } from 'vitest'
import { APICallError, RetryError } from 'ai'
import { GatewayInternalServerError, GatewayModelNotFoundError } from '@ai-sdk/gateway'
import { getAIServiceFailure } from '@/ai/service-error'
import { apiFailure, ApiError } from '@/lib/server/api'
import { getRichError } from '@/ai/tools/get-rich-error'

vi.mock('server-only', () => ({}))
afterEach(() => vi.restoreAllMocks())

describe('AI service failure classification', () => {
  it.each([
    [402, 'AI_CREDITS_EXHAUSTED', 503],
    [401, 'AI_CONFIGURATION_ERROR', 503],
    [403, 'AI_CONFIGURATION_ERROR', 503],
    [404, 'AI_MODEL_UNAVAILABLE', 503],
    [429, 'AI_PROVIDER_RATE_LIMITED', 503],
    [500, 'AI_UPSTREAM_UNAVAILABLE', 502],
  ] as const)('classifies upstream HTTP %i without exposing provider details', (statusCode, code, status) => {
    const error = new GatewayInternalServerError({ statusCode, message: 'private-token private-prompt private-provider-body' })
    expect(getAIServiceFailure(error)).toMatchObject({ code, status, upstreamStatus: statusCode })
    expect(JSON.stringify(getAIServiceFailure(error))).not.toContain('private-')
  })
  it('unwraps the SDK retry error and classifies the final failed attempt', () => {
    const error = new APICallError({ message: 'private-token', url: 'https://private-host', requestBodyValues: 'private-prompt', statusCode: 429, responseBody: 'private-body' })
    const retried = new RetryError({ message: 'private-retries', reason: 'maxRetriesExceeded', errors: [error] })
    expect(getAIServiceFailure(retried)).toMatchObject({ code: 'AI_PROVIDER_RATE_LIMITED', upstreamStatus: 429 })
    expect(JSON.stringify(getAIServiceFailure(retried))).not.toContain('private-')
  })
  it('recognizes explicit model-not-found even when the provider uses HTTP 400', () => {
    expect(getAIServiceFailure(new GatewayModelNotFoundError({ statusCode: 400 }))).toMatchObject({ code: 'AI_MODEL_UNAVAILABLE' })
  })
  it.each([undefined, new Error('private-details'), { statusCode: 402 }, new DOMException('Cancelled', 'AbortError')])('does not misclassify unrelated application errors', (error) => {
    expect(getAIServiceFailure(error)).toBeUndefined()
  })
  it('returns structured service-unavailable guidance and redacted operator diagnostics', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const response = apiFailure(new GatewayInternalServerError({ statusCode: 402, message: 'private-credit-card-info' }), 'test-request')
    expect(response.status).toBe(503)
    expect(response.headers.get('x-request-id')).toBe('test-request')
    expect(response.headers.get('cache-control')).toContain('no-store')
    const body = await response.json()
    expect(body.error).toMatchObject({ code: 'AI_CREDITS_EXHAUSTED', requestId: 'test-request' })
    expect(body.error.message).toContain('out of credits')
    expect(JSON.stringify(body)).not.toContain('private-')
    expect(log).toHaveBeenCalledWith('API request failed', { requestId: 'test-request', errorName: 'GatewayInternalServerError', code: 'AI_CREDITS_EXHAUSTED', upstreamStatus: 402 })
  })
  it('keeps user authentication errors distinct from service authentication failures', async () => {
    expect((await apiFailure(new ApiError(401, 'AUTH_REQUIRED', 'Sign in.'), 'req').json()).error.code).toBe('AUTH_REQUIRED')
    expect(getAIServiceFailure(new GatewayInternalServerError({ statusCode: 401 }))?.status).toBe(503)
  })
  it('gives file-generation tools the same credit guidance without exposing upstream details', () => {
    const result = getRichError({ action: 'generate files', error: new GatewayInternalServerError({ statusCode: 402, message: 'private-provider-body' }) })
    expect(result.error.message).toContain('out of credits')
    expect(JSON.stringify(result)).not.toContain('private-')
  })
})
