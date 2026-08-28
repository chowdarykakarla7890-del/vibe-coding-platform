import 'server-only'
import type { Session } from '@vercel/sandbox'
import { truncateUtf8, utf8ByteLength } from '@/lib/text-limits'

export const MAX_EVIDENCE_BYTES = 16_000

/** Read only bounded prefixes, including when the first stream chunk is large. */
export async function readSubmissionEvidence(sandbox: Session, paths: string[], signal: AbortSignal) {
  const evidence: string[] = []
  let remaining = MAX_EVIDENCE_BYTES
  let hasSource = false
  let truncated = false
  const uniquePaths = [...new Set(paths)]
  const missingPaths: string[] = []
  if (uniquePaths.length > 40) truncated = true
  for (const path of uniquePaths.slice(0, 40)) {
    if (remaining <= 0) { truncated = true; break }
    signal.throwIfAborted()
    const stream = await sandbox.readFile({ path }, { signal })
    if (!stream) { missingPaths.push(path); continue }
    const header = truncateUtf8(`\n--- ${path} ---\n`, remaining)
    remaining -= utf8ByteLength(header)
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of stream) {
      signal.throwIfAborted()
      const buffer = Buffer.from(chunk)
      const available = remaining - bytes
      if (available <= 0) { truncated = true; break }
      chunks.push(buffer.subarray(0, available))
      bytes += Math.min(buffer.byteLength, available)
      if (bytes >= remaining) { truncated = true; break }
    }
    // Streaming decode omits an incomplete trailing UTF-8 character when the
    // prefix ends inside a multibyte sequence instead of inserting corruption.
    const content = new TextDecoder().decode(Buffer.concat(chunks), { stream: true })
    hasSource ||= content.trim().length > 0
    evidence.push(header + content)
    remaining -= bytes
  }
  signal.throwIfAborted()
  return { text: evidence.join('') || '(No readable source files were found.)', hasSource, truncated, missingPaths }
}

export async function readSourceEvidence(sandbox: Session, paths: string[], signal: AbortSignal) {
  return (await readSubmissionEvidence(sandbox, paths, signal)).text
}
