import { z } from 'zod'
import { sourceFileSchema } from '@/lib/learning/types'
import { hasSnapshotPathConflict, MAX_PROJECT_FILES, MAX_PROJECT_SNAPSHOT_BYTES, sourceByteLength } from '@/lib/learning/snapshots'
import { projectRowSchema } from './serialization'

export const MAX_SOURCE_IMPORT_REQUEST_BYTES = 2 * 1024 * 1024
// JSON can encode each ASCII control character using six bytes. This bound
// admits every valid 10 MiB source export plus bounded metadata, not just 12 MB.
export const MAX_SOURCE_IMPORT_FILE_BYTES = MAX_PROJECT_SNAPSHOT_BYTES * 6 + 1024 * 1024
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
const utf8 = new TextEncoder()
const validText = (value: string) => !value.includes('\0') && new TextDecoder().decode(utf8.encode(value)) === value
export const importSourceFileSchema = sourceFileSchema.extend({
  path: sourceFileSchema.shape.path.refine(validText),
  content: sourceFileSchema.shape.content.refine(validText, 'Import text must be valid Unicode without null bytes'),
}).strict()
export const importSourceFilesSchema = z.array(importSourceFileSchema).max(MAX_PROJECT_FILES)
  .refine(files => new Set(files.map(file => file.path)).size === files.length, 'Import paths must be unique')
  .refine(files => !hasSnapshotPathConflict(files.map(file => file.path)), 'A source file cannot also be a folder')
  .refine(files => files.reduce((sum, file) => sum + sourceByteLength(file.content), 0) <= MAX_PROJECT_SNAPSHOT_BYTES)
export const beginSourceImportSchema = z.object({
  id: z.string().uuid(), title: z.string().trim().min(1).max(80).refine(validText),
  language: z.string().trim().min(1).max(40).refine(validText),
  fileCount: z.number().int().min(0).max(MAX_PROJECT_FILES),
  sourceBytes: z.number().int().min(0).max(MAX_PROJECT_SNAPSHOT_BYTES), digest: digestSchema,
}).strict()
export const sourceImportBatchSchema = z.object({
  files: z.array(importSourceFileSchema.extend({ digest: digestSchema }).strict()).min(1).max(20),
}).strict().refine(({ files }) => new Set(files.map(file => file.path)).size === files.length)
export const sourceImportReceiptSchema = z.object({
  id: z.string().uuid(), state: z.enum(['uploading', 'published', 'cancelled']), expiresAt: z.string().datetime({ offset: true }),
  fileCount: z.number().int().min(0).max(MAX_PROJECT_FILES), sourceBytes: z.number().int().min(0).max(MAX_PROJECT_SNAPSHOT_BYTES),
  uploadedFiles: z.number().int().min(0).max(MAX_PROJECT_FILES), uploadedBytes: z.number().int().min(0).max(MAX_PROJECT_SNAPSHOT_BYTES),
  digest: digestSchema, project: projectRowSchema.nullable(),
}).strict().refine(value => value.uploadedFiles <= value.fileCount && value.uploadedBytes <= value.sourceBytes &&
  (value.state === 'published' ? value.project?.id === value.id && value.uploadedFiles === value.fileCount && value.uploadedBytes === value.sourceBytes : value.project === null))
export type SourceImportReceipt = z.output<typeof sourceImportReceiptSchema>
export type SourceImportFile = z.infer<typeof sourceImportBatchSchema>['files'][number]

export async function textDigest(value: string) {
  const hash = await crypto.subtle.digest('SHA-256', utf8.encode(value))
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function prepareSourceImport(input: { path: string; content: string }[]) {
  const files: SourceImportFile[] = []
  for (const file of importSourceFilesSchema.parse(input)) files.push({ ...file, digest: await textDigest(file.content) })
  // PostgreSQL C collation sorts UTF-8 bytes. Code-point order matches it for
  // valid Unicode, unlike JS's default UTF-16 ordering for astral characters.
  files.sort((a, b) => {
    const left = Array.from(a.path, char => char.codePointAt(0)!)
    const right = Array.from(b.path, char => char.codePointAt(0)!)
    for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i] - right[i]
    return left.length - right.length
  })
  return { files, digest: await textDigest(files.map(file => `${file.path}:${file.digest}\n`).join('')),
    sourceBytes: files.reduce((sum, file) => sum + sourceByteLength(file.content), 0) }
}

export function sourceImportBatches(files: SourceImportFile[]) {
  const batches: SourceImportFile[][] = []
  let batch: SourceImportFile[] = []
  for (const file of files) {
    if (batch.length && (batch.length === 20 || sourceByteLength(JSON.stringify({ files: [...batch, file] })) > MAX_SOURCE_IMPORT_REQUEST_BYTES - 4096)) {
      batches.push(batch); batch = []
    }
    batch.push(file)
  }
  if (batch.length) batches.push(batch)
  return batches
}
