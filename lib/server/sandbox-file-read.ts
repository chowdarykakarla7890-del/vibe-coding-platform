import 'server-only'
import type { Session } from '@vercel/sandbox'
import { abortableRead } from '@/lib/abortable-read'
import { MAX_SOURCE_FILE_BYTES } from '@/lib/learning/snapshots'
import { ApiError } from './api'

export const SANDBOX_FILE_READ_TIMEOUT_MS = 20_000

/** One deadline covers ownership, file opens and body reads, not each chunk. */
export async function withSandboxFileRead<T>(caller: AbortSignal, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), SANDBOX_FILE_READ_TIMEOUT_MS)
  const signal = AbortSignal.any([caller, deadline.signal])
  try { return await abortableRead(() => read(signal), signal) }
  catch (error) {
    if (signal.aborted) throw new ApiError(408, 'FILE_READ_INTERRUPTED', 'The file read timed out or was cancelled. Retry without clearing saved work.')
    throw error
  } finally { clearTimeout(timer) }
}

type FileStream = NodeJS.ReadableStream & { destroy?: () => void }
function close(stream: FileStream, iterator?: AsyncIterator<unknown>) {
  // return() can also hang behind a stalled next(); observe but never await it.
  try { stream.destroy?.() } catch { /* best-effort transport cleanup */ }
  try { void Promise.resolve((iterator ?? stream[Symbol.asyncIterator]()).return?.()).catch(() => undefined) }
  catch { /* a closed transport can reject cleanup synchronously */ }
}

export async function readSandboxTextFile(vm: Pick<Session, 'readFile'>, path: string, signal: AbortSignal): Promise<string | null> {
  signal.throwIfAborted()
  const opening = vm.readFile({ path }, { signal })
  // Dispose of a stream that resolves after cancellation without reading it.
  void opening.then(stream => { if (signal.aborted && stream) close(stream) }).catch(() => undefined)
  const stream = await abortableRead(() => opening, signal)
  if (!stream) return null
  const iterator = stream[Symbol.asyncIterator]()
  const chunks: Buffer[] = []
  let size = 0
  try {
    for (;;) {
      const item = await abortableRead(() => iterator.next(), signal)
      signal.throwIfAborted()
      if (item.done) break
      const chunk = Buffer.from(item.value)
      size += chunk.byteLength
      if (size > MAX_SOURCE_FILE_BYTES) throw new ApiError(413, 'FILE_TOO_LARGE', 'Files larger than 256 KB cannot be opened in the editor or included in a source snapshot.')
      chunks.push(chunk)
    }
    let content: string
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)) }
    catch { throw new ApiError(415, 'FILE_NOT_TEXT', 'Only UTF-8 text source files can be opened or snapshotted.') }
    if (content.includes('\0')) throw new ApiError(415, 'FILE_NOT_TEXT', 'Binary files cannot be opened or included in a source snapshot.')
    return content
  } finally { close(stream, iterator) }
}
