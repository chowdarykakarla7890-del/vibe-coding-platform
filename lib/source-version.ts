import { z } from 'zod'
import { sourceFileSchema } from '@/lib/learning/types'

// Zero/null denotes a file not saved in this project yet. An omitted revision
// is create-only, never permission to overwrite an existing different file.
export const sourceRevisionSchema = z.number().int().min(0).max(2_147_483_647).nullable()
export const versionedSourceFileSchema = sourceFileSchema.extend({ revision: sourceRevisionSchema.optional() })
// The restore API only accepts text. Validate the same contract before a
// client creates a replacement VM; never drop or rewrite a damaged saved file
// just to make restoration succeed. Object schemas still allow the API to
// reject unknown fields while the client strips local snapshot metadata.
export const restorableSourceFileSchema = versionedSourceFileSchema.extend({
  content: sourceFileSchema.shape.content.refine(content => !content.includes('\0'), 'Source must be text without NUL bytes'),
})
export const sourceReceiptSchema = z.object({ path: sourceFileSchema.shape.path, revision: z.number().int().positive().max(2_147_483_647) })
export type VersionedSourceFile = z.infer<typeof versionedSourceFileSchema>
