import { createRequire } from 'node:module'
import { once } from 'node:events'
import type { Transform } from 'node:stream'
import { describe, expect, it } from 'vitest'

// Exercise the exact transitive parser used by Sandbox, not a mock of it.
const sdkRequire = createRequire(createRequire(import.meta.url).resolve('@vercel/sandbox'))
const jsonlines = sdkRequire('jsonlines') as { parse: () => Transform }

describe('Sandbox transport UTF-8 decoding', () => {
  it.each([1, 2, 7, 64])('preserves Unicode with %i-byte network fragments', async (size) => {
    const rows = [{ stream: 'stdout', data: '🙂你好 café\n' }, { stream: 'stderr', data: 'end🙂' }]
    const source = Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n'))
    const parser = jsonlines.parse()
    const actual: unknown[] = []
    parser.on('data', (row) => actual.push(row))
    const ended = once(parser, 'end')
    for (let offset = 0; offset < source.length; offset += size) parser.write(source.subarray(offset, offset + size))
    parser.end()
    await ended
    expect(actual).toEqual(rows)
  })
})
