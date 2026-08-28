import { describe, expect, it } from 'vitest'
import { getApiErrorMessage, readApiErrorMessage } from '@/lib/api-error'

describe('client API error messages', () => {
  it('extracts the structured error envelope', () => {
    expect(
      getApiErrorMessage(
        { error: { code: 'SANDBOX_EXPIRED', message: 'Restore the project.' } },
        'Fallback'
      )
    ).toBe('Restore the project.')
  })

  it('supports legacy string errors without rendering objects', () => {
    expect(getApiErrorMessage({ error: 'Legacy failure' }, 'Fallback')).toBe(
      'Legacy failure'
    )
    expect(getApiErrorMessage({ error: { code: 'NO_MESSAGE' } }, 'Fallback')).toBe(
      'Fallback'
    )
  })

  it('reads JSON response bodies and hides HTML error pages', async () => {
    await expect(
      readApiErrorMessage(
        new Response(
          JSON.stringify({ error: { message: 'Sandbox expired.' } }),
          { status: 410 }
        ),
        'Fallback'
      )
    ).resolves.toBe('Sandbox expired.')

    await expect(
      readApiErrorMessage(
        new Response('<html>upstream details</html>', { status: 502 }),
        'Safe fallback'
      )
    ).resolves.toBe('Safe fallback')
  })
})
