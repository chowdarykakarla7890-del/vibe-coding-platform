import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { streamTextMock } = vi.hoisted(() => ({ streamTextMock: vi.fn() }))

vi.mock('ai', () => ({
  Output: { array: vi.fn((value) => value) },
  streamText: streamTextMock,
}))

import { getContents } from '../ai/tools/generate-files/get-contents'

const generatedFiles = [
  { path: 'app/page.tsx', content: 'export default function Page() {}' },
  { path: 'app/layout.tsx', content: 'export default function Layout() {}' },
  { path: 'package.json', content: '{"private":true}' },
]

describe('progressive file generation', () => {
  beforeEach(() => {
    streamTextMock.mockReturnValue({
      elementStream: (async function* () {
        for (const file of generatedFiles) yield file
      })(),
      output: Promise.resolve(generatedFiles),
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('emits every completed file immediately without a two-file buffer', async () => {
    const chunks = []
    for await (const chunk of getContents({
      messages: [],
      modelId: 'test/model',
      paths: generatedFiles.map((file) => file.path),
    })) {
      chunks.push(chunk)
    }

    expect(chunks).toHaveLength(3)
    expect(chunks.map((chunk) => chunk.files[0]?.path)).toEqual(
      generatedFiles.map((file) => file.path)
    )
    expect(chunks.every((chunk) => chunk.files.length === 1)).toBe(true)
  })

  it('cancels the nested provider when a consumer closes after a failed save', async () => {
    const iterator = getContents({ messages: [], modelId: 'test/model', paths: generatedFiles.map((file) => file.path) })
    await iterator.next()
    const signal = streamTextMock.mock.calls.at(-1)![0].abortSignal as AbortSignal
    expect(signal.aborted).toBe(false)
    await iterator.return(undefined)
    expect(signal.aborted).toBe(true)
  })

  it('propagates Stop and does not yield another file', async () => {
    const controller = new AbortController()
    const iterator = getContents({ messages: [], modelId: 'test/model', paths: generatedFiles.map((file) => file.path), abortSignal: controller.signal })
    await iterator.next()
    controller.abort()
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('does not claim completion when the provider omits a requested file', async () => {
    const iterator = getContents({ messages: [], modelId: 'test/model', paths: [...generatedFiles.map((file) => file.path), 'missing.ts'] })
    for (let index = 0; index < generatedFiles.length; index++) await iterator.next()
    await expect(iterator.next()).rejects.toThrow('did not finish all requested files')
  })
})
