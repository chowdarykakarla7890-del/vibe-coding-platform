import { Readable } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { readSandboxTextFile, SANDBOX_FILE_READ_TIMEOUT_MS, withSandboxFileRead } from '@/lib/server/sandbox-file-read'
import { MAX_SOURCE_FILE_BYTES } from '@/lib/learning/snapshots'

vi.mock('server-only', () => ({}))
afterEach(() => vi.useRealTimers())
const idle = new AbortController().signal
function sandbox(stream: Readable | null) { return { readFile: vi.fn(async () => stream) } }

it('preserves split UTF-8 and a source BOM byte-for-byte', async () => {
  const content = '\uFEFFexport const text = "🙂 café"'
  const bytes = Buffer.from(content)
  const stream = Readable.from(Array.from(bytes, byte => Buffer.from([byte])))
  const vm = sandbox(stream)
  await expect(readSandboxTextFile(vm, 'main.ts', idle)).resolves.toBe(content)
  expect(vm.readFile).toHaveBeenCalledWith({ path: 'main.ts' }, { signal: idle })
  expect(stream.destroyed).toBe(true)
})

it.each([
  ['invalid UTF-8', Buffer.from([0xff]), 'FILE_NOT_TEXT'],
  ['binary content', Buffer.from('a\0b'), 'FILE_NOT_TEXT'],
  ['oversize content', Buffer.alloc(MAX_SOURCE_FILE_BYTES + 1, 65), 'FILE_TOO_LARGE'],
])('rejects %s without leaking an open stream', async (_name, bytes, code) => {
  const stream = Readable.from([bytes])
  await expect(readSandboxTextFile(sandbox(stream), 'main.txt', idle)).rejects.toMatchObject({ code })
  expect(stream.destroyed).toBe(true)
})

it('accepts the exact byte limit and distinguishes an empty file from a missing file', async () => {
  await expect(readSandboxTextFile(sandbox(Readable.from([Buffer.alloc(MAX_SOURCE_FILE_BYTES, 65)])), 'main.txt', idle)).resolves.toHaveLength(MAX_SOURCE_FILE_BYTES)
  await expect(readSandboxTextFile(sandbox(Readable.from([])), 'empty.txt', idle)).resolves.toBe('')
  await expect(readSandboxTextFile(sandbox(null), 'missing.txt', idle)).resolves.toBeNull()
})

it('closes a stalled body at the shared deadline', async () => {
  vi.useFakeTimers()
  const stream = new Readable({ read() {} })
  const result = withSandboxFileRead(idle, signal => readSandboxTextFile(sandbox(stream), 'main.ts', signal))
  const assertion = expect(result).rejects.toMatchObject({ status: 408, code: 'FILE_READ_INTERRUPTED' })
  await vi.advanceTimersByTimeAsync(SANDBOX_FILE_READ_TIMEOUT_MS)
  await assertion
  expect(stream.destroyed).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it('settles caller cancellation without waiting for a stuck next or return', async () => {
  const next = vi.fn(() => new Promise<IteratorResult<Buffer>>(() => {}))
  const returned = vi.fn(() => new Promise<IteratorResult<Buffer>>(() => {}))
  const destroy = vi.fn()
  const stream = { destroy, [Symbol.asyncIterator]: () => ({ next, return: returned }) }
  const controller = new AbortController()
  const result = withSandboxFileRead(controller.signal, signal => readSandboxTextFile({ readFile: async () => stream } as never, 'main.ts', signal))
  const assertion = expect(result).rejects.toMatchObject({ code: 'FILE_READ_INTERRUPTED' })
  await vi.waitFor(() => expect(next).toHaveBeenCalledOnce())
  controller.abort()
  await assertion
  expect(destroy).toHaveBeenCalledOnce()
  expect(returned).toHaveBeenCalledOnce()
})

it('disposes of a stream whose open finishes after timeout', async () => {
  vi.useFakeTimers()
  let finish!: (stream: Readable) => void
  const vm = { readFile: vi.fn(() => new Promise<Readable>(resolve => { finish = resolve })) }
  const result = withSandboxFileRead(idle, signal => readSandboxTextFile(vm, 'main.ts', signal))
  const assertion = expect(result).rejects.toMatchObject({ code: 'FILE_READ_INTERRUPTED' })
  await vi.advanceTimersByTimeAsync(SANDBOX_FILE_READ_TIMEOUT_MS)
  await assertion
  const stream = new Readable({ read() { throw new Error('Late source must never be read') } })
  finish(stream)
  await vi.advanceTimersByTimeAsync(0)
  expect(stream.destroyed).toBe(true)
})

it('does not start an already-cancelled read or retain a successful deadline', async () => {
  vi.useFakeTimers()
  const read = vi.fn(async () => 'value')
  await expect(withSandboxFileRead(AbortSignal.abort(), read)).rejects.toMatchObject({ code: 'FILE_READ_INTERRUPTED' })
  expect(read).not.toHaveBeenCalled()
  await expect(withSandboxFileRead(idle, read)).resolves.toBe('value')
  expect(vi.getTimerCount()).toBe(0)
})
