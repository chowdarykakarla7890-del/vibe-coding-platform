import { Readable } from 'node:stream'
import type { Session } from '@vercel/sandbox'
import { describe, expect, it, vi } from 'vitest'
import { MAX_EVIDENCE_BYTES, readSourceEvidence, readSubmissionEvidence } from '@/lib/server/activity-evidence'
vi.mock('server-only', () => ({}))

describe('bounded source evidence', () => {
  it('keeps the beginning of a large first chunk within the byte budget', async () => {
    const readFile = vi.fn(async () => Readable.from([Buffer.from('😀'.repeat(20_000))]))
    const sandbox = { readFile } as unknown as Session
    const evidence = await readSourceEvidence(sandbox, ['main.js', 'unused.js'], new AbortController().signal)
    expect(evidence).toContain('main.js')
    expect(evidence).toContain('😀')
    expect(evidence).not.toContain('\uFFFD')
    expect(Buffer.byteLength(evidence)).toBeLessThanOrEqual(MAX_EVIDENCE_BYTES)
    expect(readFile).toHaveBeenCalledOnce()
  })
  it('deduplicates files and closes reads when cancelled', async () => {
    const controller = new AbortController()
    const readFile = vi.fn(async () => Readable.from(['hello']))
    const sandbox = { readFile } as unknown as Session
    expect(await readSourceEvidence(sandbox, ['main.js', 'main.js'], controller.signal)).toContain('hello')
    expect(readFile).toHaveBeenCalledOnce()
    controller.abort()
    await expect(readSourceEvidence(sandbox, ['main.js'], controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(readFile).toHaveBeenCalledOnce()
  })
  it('distinguishes missing, empty and partial evidence from complete readable source', async () => {
    const readFile = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(Readable.from(['  ']))
    const sandbox = { readFile } as unknown as Session
    expect(await readSubmissionEvidence(sandbox, ['missing.js', 'empty.js'], new AbortController().signal))
      .toMatchObject({ hasSource: false, truncated: false, missingPaths: ['missing.js'] })
    readFile.mockResolvedValueOnce(Readable.from(['x'.repeat(MAX_EVIDENCE_BYTES + 1)]))
    expect(await readSubmissionEvidence(sandbox, ['large.js'], new AbortController().signal)).toMatchObject({ hasSource: true, truncated: true })
    readFile.mockResolvedValueOnce(Readable.from(['export const value = 42']))
    expect(await readSubmissionEvidence(sandbox, ['main.js'], new AbortController().signal)).toMatchObject({ hasSource: true, truncated: false, missingPaths: [] })
  })
})
