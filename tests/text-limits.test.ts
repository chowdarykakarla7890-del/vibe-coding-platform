import { describe, expect, it } from 'vitest'
import { truncateUtf8, utf8ByteLength } from '@/lib/text-limits'

describe('UTF-8 output limits', () => {
  it('keeps short output unchanged', () => {
    expect(truncateUtf8('hello', 10)).toBe('hello')
  })

  it('never splits a multibyte character or exceeds the byte cap', () => {
    const result = truncateUtf8('🙂🙂🙂', 9)
    expect(result).toBe('🙂🙂')
    expect(utf8ByteLength(result)).toBeLessThanOrEqual(9)
    expect(result).not.toContain('�')
  })
})
