import { afterEach, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import type { Command } from '@vercel/sandbox'
import { readCommandLogs } from '@/lib/server/command-output'
import { COMMAND_OUTPUT_PROGRAM } from '@/lib/sandbox/output-program.mjs'

vi.mock('server-only', () => ({}))
afterEach(() => vi.restoreAllMocks())
const frame = (sequence: number, data: Buffer | null) => `CT1:${sequence}:${data === null ? '.' : data.toString('base64')}\n`
function fixture(parts: { stream: 'stdout' | 'stderr'; data: string }[]) {
  const close = vi.fn()
  const command = { logs: () => Object.assign((async function* () { yield* parts })(), { close }) } as unknown as Command
  return { command, close }
}
async function collect(command: Command, encoding: 'raw' | 'base64-v1' = 'base64-v1') {
  const output = { stdout: '', stderr: '' }
  for await (const item of readCommandLogs(command, encoding, new AbortController().signal)) output[item.stream] += item.data
  return output
}
it.each([1, 2, 7, 8192])('preserves UTF-8 split across raw frames and %s-character SDK fragments', async size => {
  const text = '\uFEFF🙂你好 café\n'.repeat(1000), bytes = Buffer.from(text)
  let encoded = '', index = 0
  for (let i = 0; i < bytes.length; i += 3071) encoded += frame(index++, bytes.subarray(i, i + 3071))
  encoded += frame(index, null)
  const parts: { stream: 'stdout' | 'stderr'; data: string }[] = []
  for (let i = 0; i < encoded.length; i += size) parts.push({ stream: 'stdout', data: encoded.slice(i, i + size) })
  parts.splice(2, 0, { stream: 'stderr', data: frame(0, Buffer.from('⚠️ stderr')) + frame(1, null) })
  const f = fixture(parts)
  expect(await collect(f.command)).toEqual({ stdout: text, stderr: '⚠️ stderr' })
  expect(f.close).toHaveBeenCalled()
})
it.each(['CT1:1:YQ==\n', 'CT1:0:YQ=\n', 'CT1:0:!\n', 'CT1:0:YQ==', 'x'.repeat(4129), 'CT1:0:.\nCT1:1:YQ==\n'])('rejects corrupt/truncated framing without accepting raw fallback', async data => {
  await expect(collect(fixture([{ stream: 'stdout', data }]).command)).rejects.toThrow('output')
})
it('does not interpret framing-looking text in historical raw output', async () => {
  const text = 'CT1:0:YQ==\n'
  expect((await collect(fixture([{ stream: 'stdout', data: text }]).command, 'raw')).stdout).toBe(text)
})
it('preserves complete frames on abrupt process termination without EOF markers', async () => {
  expect((await collect(fixture([{ stream: 'stdout', data: frame(0, Buffer.from('done🙂')) }]).command)).stdout).toBe('done🙂')
})
it('close cancels a pending upstream next without waiting for the idle process', async () => {
  const entered = Promise.withResolvers<void>(), close = vi.fn()
  const command = { logs: () => ({ next: () => { entered.resolve(); return new Promise(() => {}) }, close }) } as unknown as Command
  const logs = readCommandLogs(command, 'base64-v1', new AbortController().signal)
  const pending = logs.next()
  await entered.promise; logs.close()
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  expect(close).toHaveBeenCalled()
})
it('executes the real byte encoder incrementally, preserving argv, streams and nonzero exit', async () => {
  const chunk = '🙂你好\n', repeats = 15000, text = chunk.repeat(repeats), argument = '$(not executed); spaces'
  // Generate the large payload in the child: passing it as one argv entry
  // exceeds Linux's per-argument limit before the encoder can even start.
  const script = 'import os,sys,time;os.write(1,sys.argv[1].encode()*int(sys.argv[2]));time.sleep(0.05);os.write(2,sys.argv[3].encode());sys.exit(3)'
  const child = spawn('python3', ['-I', '-S', '-c', COMMAND_OUTPUT_PROGRAM, 'python3', '-I', '-S', '-c', script, chunk, String(repeats), argument], { stdio: ['ignore', 'pipe', 'pipe'] })
  const parts: { stream: 'stdout' | 'stderr'; data: string }[] = []
  child.stdout.on('data', data => { expect(/^[\x00-\x7f]*$/.test(data.toString())).toBe(true); parts.push({ stream: 'stdout', data: data.toString() }) })
  child.stderr.on('data', data => parts.push({ stream: 'stderr', data: data.toString() }))
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  expect(code).toBe(3)
  expect(await collect(fixture(parts).command)).toEqual({ stdout: text, stderr: argument })
})
