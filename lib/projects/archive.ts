import { z } from 'zod'
import { sourceByteLength } from '@/lib/learning/snapshots'

export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
export const MAX_ARCHIVE_RECORD_BYTES = 2 * 1024 * 1024
export const originalArchiveKinds = ['project', 'source', 'message', 'conflict', 'conflict-copy', 'submission', 'submission-source', 'submission-file', 'assessment', 'activity', 'portfolio-project', 'capture-status'] as const
export const archiveKinds = [...originalArchiveKinds, 'archive-section'] as const
export const archiveReceiptSchema = z.object({
  id: z.string().uuid(), projectId: z.string().uuid(),
  createdAt: z.string().datetime({ offset: true }), expiresAt: z.string().datetime({ offset: true }),
  recordCount: z.number().int().min(1).max(50_000), payloadBytes: z.number().int().min(1).max(MAX_ARCHIVE_BYTES),
  formatVersion: z.union([z.literal(2), z.literal(3)]).optional(),
}).strict()
export const archiveManifestSchema = archiveReceiptSchema.omit({ formatVersion: true }).extend({
  format: z.literal('codetutor-project-archive'), version: z.union([z.literal(2), z.literal(3)]), scope: z.literal('saved-project'),
  includesUnsavedDrafts: z.literal(false), includesLiveSandboxFiles: z.literal(false),
}).strict()
export type ArchiveManifest = z.infer<typeof archiveManifestSchema>
export const archiveSectionSchema = z.object({
  manifest: archiveManifestSchema, digest: z.string().regex(/^[a-f0-9]{64}$/),
  rootRecordCount: z.number().int().min(1).max(50_000), rootPayloadBytes: z.number().int().min(1).max(MAX_ARCHIVE_BYTES),
  rootDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().refine(value => value.rootRecordCount <= value.manifest.recordCount && value.rootPayloadBytes <= value.manifest.payloadBytes &&
  (value.manifest.version === 3 || (value.rootRecordCount === value.manifest.recordCount && value.rootPayloadBytes === value.manifest.payloadBytes && value.rootDigest === value.digest)))
export type ArchiveSection = z.infer<typeof archiveSectionSchema>
export const archiveRecordSchema = z.object({
  kind: z.enum(archiveKinds), key: z.string().min(1).max(256), data: z.record(z.unknown()),
}).strict()
export const archiveEnvelopeSchema = z.object({
  index: z.number().int().min(1).max(50_000),
  record: z.string().max(MAX_ARCHIVE_RECORD_BYTES).refine(value => sourceByteLength(value) <= MAX_ARCHIVE_RECORD_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sectionId: z.string().uuid().refine(value => value === value.toLowerCase()).optional(), sectionIndex: z.number().int().min(1).max(50_000).optional(),
}).strict().refine(value => (value.sectionId === undefined) === (value.sectionIndex === undefined))
export const archivePageSchema = z.object({
  id: z.string().uuid(), records: z.array(archiveEnvelopeSchema).max(20),
  nextCursor: z.number().int().min(1).max(50_000).nullable(),
}).strict()
export type ArchiveReceipt = z.infer<typeof archiveReceiptSchema>
export type ArchiveEnvelope = z.infer<typeof archiveEnvelopeSchema>

/** v3 binds classification and local ordering as well as record content. */
export function archiveDigestLine(record: ArchiveEnvelope, version: 2 | 3) {
  return version === 2 ? `${record.index}:${record.sha256}\n`
    : `${record.index}:${record.sha256}:${record.sectionId ?? ''}:${record.sectionIndex ?? 0}\n`
}

/** Validate a frozen page before adding any of it to a downloadable archive.
 * Hashes detect incomplete/corrupt transport, not authenticity of imported data.
 */
export async function verifyArchivePage(receipt: ArchiveReceipt, page: z.infer<typeof archivePageSchema>, after: number) {
  if (page.id !== receipt.id || !page.records.length || after + page.records.length > receipt.recordCount) throw new Error('Archive page is incomplete or belongs to another export.')
  let bytes = 0
  for (const [offset, record] of page.records.entries()) {
    if (record.index !== after + offset + 1) throw new Error('Archive records are missing or out of order.')
    const encoded = new TextEncoder().encode(record.record)
    const hash = await crypto.subtle.digest('SHA-256', encoded)
    const actual = Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('')
    if (actual !== record.sha256) throw new Error('Archive integrity check failed. Retry without deleting your project.')
    const decoded = archiveRecordSchema.safeParse(JSON.parse(record.record))
    if (!decoded.success || (record.index === 1 && (decoded.data.kind !== 'project' || decoded.data.data.id !== receipt.projectId))) throw new Error('Archive record is invalid.')
    bytes += encoded.byteLength
  }
  const next = after + page.records.length
  if (page.nextCursor !== (next < receipt.recordCount ? next : null)) throw new Error('Archive pagination did not match its manifest.')
  return bytes
}
