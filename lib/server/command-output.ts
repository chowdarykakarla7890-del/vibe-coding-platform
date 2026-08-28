import 'server-only'
import { StringDecoder } from 'node:string_decoder'
import type { Command } from '@vercel/sandbox'
import { abortableRead } from '@/lib/abortable-read'

export type CommandOutputEncoding = 'raw' | 'base64-v1'
type Output = { stream: 'stdout' | 'stderr'; data: string }
const MAX_FRAME_CHARS = 4_128

/** This format comes from the server-owned command audit, never output sniffing
 * or user input. Old raw commands remain readable without misinterpreting text. */
export function readCommandLogs(command: Command, encoding: CommandOutputEncoding, signal: AbortSignal) {
  const cancelled = new AbortController()
  const readSignal = AbortSignal.any([signal, cancelled.signal])
  let source: ReturnType<Command['logs']> | undefined
  function close() { cancelled.abort(); source?.close() }
  const iterator = (async function* (): AsyncGenerator<Output> {
    const states = {
      stdout: { pending: '', sequence: 0, ended: false, text: new StringDecoder('utf8') },
      stderr: { pending: '', sequence: 0, ended: false, text: new StringDecoder('utf8') },
    }
    try {
      readSignal.throwIfAborted()
      source = command.logs({ signal: readSignal })
      while (true) {
        const result = await abortableRead(() => source!.next(), readSignal)
        if (result.done) break
        if (encoding === 'raw') { yield result.value; continue }
        const { stream, data } = result.value
        const state = states[stream]
        let start = 0
        while (start < data.length) {
          readSignal.throwIfAborted()
          const newline = data.indexOf('\n', start)
          const end = newline === -1 ? data.length : newline
          if (state.ended || state.pending.length + end - start > MAX_FRAME_CHARS) throw new Error('Command output framing is invalid.')
          state.pending += data.slice(start, end)
          start = end + 1
          if (newline === -1) break
          const match = /^CT1:([0-9]{1,16}):([A-Za-z0-9+/]+={0,2}|\.)$/.exec(state.pending)
          state.pending = ''
          if (!match || Number(match[1]) !== state.sequence++) throw new Error('Command output sequence is incomplete.')
          let text: string
          if (match[2] === '.') {
            state.ended = true
            text = state.text.end()
          } else {
            const bytes = Buffer.from(match[2], 'base64')
            if (bytes.length > 3072 || bytes.toString('base64') !== match[2]) throw new Error('Command output encoding is invalid.')
            text = state.text.write(bytes)
          }
          if (text) yield { stream, data: text }
        }
      }
      if (encoding !== 'raw') for (const stream of ['stdout', 'stderr'] as const) {
        const state = states[stream]
        // A killed process need not write its final marker. Complete frames
        // still form a valid prefix; never acknowledge a partial frame.
        if (state.pending) throw new Error('Command output ended in an incomplete frame.')
        if (!state.ended) {
          const text = state.text.end()
          if (text) yield { stream, data: text }
        }
      }
    } finally { close() }
  })()
  return Object.assign(iterator, { close })
}
