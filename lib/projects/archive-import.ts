import { z } from 'zod'
import { archiveDigestLine, archiveEnvelopeSchema, archiveManifestSchema, archiveRecordSchema, archiveSectionSchema, type ArchiveEnvelope, type ArchiveManifest, type ArchiveSection } from './archive'
import { importSourceFileSchema, textDigest } from './source-import'
import { projectRowSchema } from './serialization'
import { hasSnapshotPathConflict, MAX_PROJECT_FILES, MAX_PROJECT_SNAPSHOT_BYTES, sourceByteLength } from '@/lib/learning/snapshots'
import { abortableRead } from '@/lib/abortable-read'

export const MAX_ARCHIVE_UPLOAD_BYTES = 4 * 1024 * 1024 + 2048
export const MAX_ARCHIVE_DOWNLOAD_FILE_BYTES = 520 * 1024 * 1024
export { archiveManifestSchema, type ArchiveManifest } from './archive'
export const beginArchiveImportSchema = z.object({
  id: z.string().uuid(), manifest: archiveManifestSchema, digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
export const archiveImportUploadSchema = z.object({ records: z.array(archiveEnvelopeSchema).min(1).max(20) }).strict()
export const archiveImportReceiptSchema = z.object({
  id: z.string().uuid(), state: z.enum(['uploading', 'published', 'cancelled']), expiresAt: z.string().datetime({ offset: true }),
  manifest: archiveManifestSchema, digest: z.string().regex(/^[a-f0-9]{64}$/),
  uploadedRecords: z.number().int().min(0).max(50_000), uploadedBytes: z.number().int().min(0).max(256 * 1024 * 1024),
  project: projectRowSchema.nullable(),
}).strict().refine(value => value.uploadedRecords <= value.manifest.recordCount && value.uploadedBytes <= value.manifest.payloadBytes &&
  (value.state === 'published' ? value.project?.id === value.id && value.uploadedRecords === value.manifest.recordCount && value.uploadedBytes === value.manifest.payloadBytes : value.project === null))
export type ArchiveImportReceipt = z.output<typeof archiveImportReceiptSchema>
export const importedArchivePageSchema = z.object({
  id: z.string().uuid(), manifest: archiveManifestSchema, digest: z.string().regex(/^[a-f0-9]{64}$/),
  provenance: z.literal('imported-unverified'), records: z.array(archiveEnvelopeSchema).min(1).max(20),
  nextCursor: z.number().int().min(1).max(50_000).nullable(),
}).strict()
export type ImportedArchivePage = z.infer<typeof importedArchivePageSchema>

const archivedProjectSchema = z.object({
  id: z.string().uuid(), title: z.string().min(1).max(100), language: z.string().min(1).max(40),
  mode: z.enum(['playground', 'practice', 'debug', 'challenge', 'project', 'dsa']),
  activityId: z.string().max(128).nullable(), status: z.enum(['active', 'completed', 'archived']),
  createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }),
}).strict()
const archivedSourceSchema = importSourceFileSchema.extend({ revision: z.number().int().positive(), deleted: z.boolean(), updatedAt: z.string().datetime({ offset: true }) }).strict()

/** Bound traversal before any recursive renderer/schema sees foreign JSON.
 * Other history is opaque evidence, not tool messages or grading authority.
 */
function assertBoundedJson(root: unknown) {
  const stack: Array<[unknown, number]> = [[root, 0]]
  let nodes = 0
  while (stack.length) {
    const [value, depth] = stack.pop()!
    if (++nodes > 100_000 || depth > 32) throw new Error('Archive record is too deeply nested or complex.')
    if (typeof value === 'string' && (value.includes('\0') || new TextDecoder().decode(new TextEncoder().encode(value)) !== value)) throw new Error('Archive text must be valid Unicode without null bytes.')
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Archive numbers must be finite.')
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key) || key.includes('\0') || new TextDecoder().decode(new TextEncoder().encode(key)) !== key) throw new Error('Archive record contains an unsafe object key.')
        stack.push([child, depth + 1])
      }
    }
  }
}

export async function validateImportedEnvelope(input: unknown, manifest?: ArchiveManifest) {
  const envelope = archiveEnvelopeSchema.parse(input)
  if (await textDigest(envelope.record) !== envelope.sha256) throw new Error('Archive checksum failed. The file has not been imported.')
  const raw: unknown = JSON.parse(envelope.record)
  assertBoundedJson(raw)
  const record = archiveRecordSchema.parse(raw)
  if (manifest?.version === 2 && (envelope.sectionId || record.kind === 'archive-section')) throw new Error('History sections require a version-3 archive.')
  if (record.kind === 'archive-section') {
    const section = archiveSectionSchema.parse(record.data)
    if (envelope.sectionId || envelope.index === 1 || record.key !== section.manifest.id.toLowerCase() || record.key === manifest?.id.toLowerCase() || sourceByteLength(envelope.record) > 4096) throw new Error('Archive history section is invalid.')
  }
  if (record.kind === 'project') {
    const project = archivedProjectSchema.parse(record.data)
    if ((envelope.sectionId ? envelope.sectionIndex !== 1 : envelope.index !== 1) || record.key !== project.id || (manifest && !envelope.sectionId && project.id !== manifest.projectId)) throw new Error('Archive project identity is inconsistent.')
  } else if (envelope.index === 1 || envelope.sectionIndex === 1) throw new Error('Archive sections must begin with their project record.')
  if (record.kind === 'source') {
    const source = archivedSourceSchema.parse(record.data)
    if (record.key !== source.path || (source.deleted && source.content !== '')) throw new Error('Archive source record is invalid.')
  }
  return { envelope, record }
}

/** Read bounded UTF-8 lines; never load an entire 256 MiB history into memory.
 * The selected Blob is immutable, and its stream can be read again for upload.
 */
async function* archiveLines(file: Blob, signal: AbortSignal) {
  if (file.size > MAX_ARCHIVE_DOWNLOAD_FILE_BYTES) throw new Error('This archive exceeds the supported download-file limit.')
  const reader = file.stream().getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let pending = ''
  try {
    while (true) {
      const chunk = await abortableRead(() => reader.read(), signal)
      pending += decoder.decode(chunk.done ? undefined : chunk.value, { stream: !chunk.done })
      let newline: number
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (!line || sourceByteLength(line) > MAX_ARCHIVE_UPLOAD_BYTES) throw new Error('Archive has an empty or oversized record.')
        yield line
      }
      if (sourceByteLength(pending) > MAX_ARCHIVE_UPLOAD_BYTES) throw new Error('Archive record exceeds the supported limit.')
      if (chunk.done) break
    }
    if (pending) yield pending
  } finally { void reader.cancel().catch(() => undefined); reader.releaseLock() }
}

export async function* readArchive(file: Blob, signal: AbortSignal) {
  let manifest: ArchiveManifest | undefined
  let count = 0, bytes = 0, complete = false, sourceBytes = 0
  const keys = new Set<string>(), paths: string[] = [], digests: string[] = []
  const sectionIds = new Set<string>()
  let section: { id: string; data: ArchiveSection; count: number; bytes: number; digests: string[] } | undefined
  const finishSection = async () => {
    if (section && (section.count !== section.data.rootRecordCount || section.bytes !== section.data.rootPayloadBytes ||
      await textDigest(section.digests.join('')) !== section.data.rootDigest)) throw new Error('Imported history section is incomplete or corrupted.')
  }
  for await (const line of archiveLines(file, signal)) {
    signal.throwIfAborted()
    if (complete) throw new Error('Archive contains records after its completion marker.')
    const value: unknown = JSON.parse(line)
    if (!manifest) {
      manifest = archiveManifestSchema.parse(value)
      yield { type: 'manifest' as const, manifest }
    } else if (count === manifest.recordCount) {
      const end = z.object({ complete: z.literal(true), id: z.literal(manifest.id), recordCount: z.literal(count), payloadBytes: z.literal(bytes) }).strict().parse(value)
      if (end.payloadBytes !== manifest.payloadBytes) throw new Error('Archive bytes do not match its manifest.')
      await finishSection()
      if (hasSnapshotPathConflict(paths)) throw new Error('An archived source file also occupies a folder.')
      complete = true
      yield { type: 'complete' as const, digest: await textDigest(digests.join('')), fileCount: paths.length, sourceBytes }
    } else {
      const { envelope, record } = await validateImportedEnvelope(value, manifest)
      if (envelope.index !== ++count) throw new Error('Archive records are missing or out of order.')
      const key = JSON.stringify([envelope.sectionId ?? null, record.kind, record.key])
      if (keys.has(key)) throw new Error('Archive contains duplicate records.')
      keys.add(key)
      bytes += sourceByteLength(envelope.record)
      if (bytes > manifest.payloadBytes) throw new Error('Archive exceeds its declared size.')
      if (record.kind === 'archive-section') {
        await finishSection()
        if (sectionIds.has(record.key)) throw new Error('Archive history section is duplicated.')
        sectionIds.add(record.key)
        section = { id: record.key, data: archiveSectionSchema.parse(record.data), count: 0, bytes: 0, digests: [] }
      } else if (envelope.sectionId) {
        if (!section || section.id !== envelope.sectionId || envelope.sectionIndex !== section.count + 1 ||
          (envelope.sectionIndex === 1 && record.data.id !== section.data.manifest.projectId)) throw new Error('Archive history section identity or order is invalid.')
        section.count++; section.bytes += sourceByteLength(envelope.record)
        section.digests.push(archiveDigestLine({ ...envelope, index: envelope.sectionIndex! }, 2))
        if (section.count > section.data.rootRecordCount || section.bytes > section.data.rootPayloadBytes) throw new Error('History section exceeds its declared size.')
      } else if (section) throw new Error('Current project records cannot follow imported history.')
      if (!envelope.sectionId && record.kind === 'source' && !record.data.deleted) {
        paths.push(record.data.path as string)
        sourceBytes += sourceByteLength(record.data.content as string)
        if (paths.length > MAX_PROJECT_FILES || sourceBytes > MAX_PROJECT_SNAPSHOT_BYTES) throw new Error('Archived source exceeds the workspace file limits.')
      }
      digests.push(archiveDigestLine(envelope, manifest.version))
      yield { type: 'record' as const, envelope }
    }
  }
  if (!complete) throw new Error('Archive is incomplete. No project can be published.')
}

export async function inspectArchive(file: Blob, signal: AbortSignal, progress: (count: number) => void = () => {}) {
  let manifest: ArchiveManifest | undefined
  let verified: { digest: string; fileCount: number; sourceBytes: number } | undefined
  for await (const item of readArchive(file, signal)) {
    if (item.type === 'manifest') manifest = item.manifest
    if (item.type === 'record') progress(item.envelope.index)
    if (item.type === 'complete') verified = item
  }
  if (manifest && verified) return { manifest, digest: verified.digest, fileCount: verified.fileCount, sourceBytes: verified.sourceBytes }
  throw new Error('Archive is incomplete.')
}

export function archiveBatchFits(records: ArchiveEnvelope[]) {
  return records.length <= 20 && sourceByteLength(JSON.stringify({ records })) <= MAX_ARCHIVE_UPLOAD_BYTES
}
