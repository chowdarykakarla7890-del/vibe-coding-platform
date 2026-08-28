import { describe, expect, it, vi } from 'vitest'
import { APIError, StreamError } from '@vercel/sandbox'
import { ApiError } from '@/lib/server/api'
import { getRichError } from '@/ai/tools/get-rich-error'

vi.mock('server-only', () => ({}))

describe('public tool error redaction', () => {
  it.each([
    new Error('private-provider-token'),
    { token: 'private-provider-token' },
    new APIError(new Response('', { status: 502 }), { message: 'private-provider-token', json: { token: 'private-provider-token' }, text: 'private-provider-token' }),
  ])('does not forward upstream details or source arguments', (error) => {
    const result = getRichError({ action: 'write files', args: { content: 'private-source-code' }, error })
    expect(JSON.stringify(result)).not.toContain('private-')
    expect(Object.keys(result.error)).toEqual(['message'])
  })
  it('preserves sanitized application guidance and recognizes stopped SDK streams', () => {
    expect(getRichError({ action: 'verify', error: new ApiError(401, 'AUTH_REQUIRED', 'Sign in to continue.') }).error.message).toBe('Sign in to continue.')
    expect(getRichError({ action: 'read', error: new StreamError('sandbox_stopped', 'private-details', 'session-id') }).error.message).toContain('expired')
  })
})
